# Anemo Desktop's PowerShell parse helper (docs/specs/25-device-permission-profiles.md §5.1).
# It only PARSES: each line on stdin is a command as base64 UTF-8; each answer is one line of
# JSON on stdout describing the command's syntax tree, for Permissions/PowerShellAnalyser.cs.
# Nothing it reads is ever run: there is no Invoke-Expression, no script block invocation and
# no expansion of the input here.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$L = 'System.Management.Automation.Language'

function Cut([string] $text) {
    if ($null -eq $text) { return '' }
    if ($text.Length -gt 300) { return $text.Substring(0, 300) }
    return $text
}

function El($e) {
    if ($null -eq $e) { return @{ t = 'none' } }
    if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        $h = @{ t = 'param'; name = [string]$e.ParameterName }
        if ($null -ne $e.Argument) { $h.arg = El $e.Argument }
        return $h
    }
    if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return @{ t = 'str'; v = [string]$e.Value; kind = [string]$e.StringConstantType }
    }
    if ($e -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
        $vars = @()
        $sub = $false
        foreach ($n in $e.NestedExpressions) {
            if ($n -is [System.Management.Automation.Language.VariableExpressionAst]) { $vars += [string]$n.VariablePath.UserPath }
            else { $sub = $true }
        }
        return @{ t = 'expand'; v = [string]$e.Value; text = (Cut $e.Extent.Text); vars = @($vars); sub = $sub }
    }
    if ($e -is [System.Management.Automation.Language.VariableExpressionAst]) {
        $kind = 'var'
        if ($e.Splatted) { $kind = 'splat' }
        return @{ t = $kind; v = [string]$e.VariablePath.UserPath }
    }
    if ($e -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { return @{ t = 'block' } }
    if ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) { return @{ t = 'const'; v = [string]$e.Value } }
    if ($e -is [System.Management.Automation.Language.ArrayLiteralAst]) {
        return @{ t = 'array'; items = @($e.Elements | ForEach-Object { El $_ }) }
    }
    return @{ t = 'other'; text = (Cut $e.Extent.Text) }
}

function Describe([string] $text) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        return @{ ok = $false; error = (Cut $errors[0].Message) }
    }
    $commands = @()
    $all = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
    foreach ($c in $all) {
        $pipe = $c.Parent
        $index = 0
        $count = 1
        $prev = ''
        $pipeId = $c.Extent.StartOffset
        if ($pipe -is [System.Management.Automation.Language.PipelineAst]) {
            $elements = @($pipe.PipelineElements)
            $count = $elements.Count
            for ($i = 0; $i -lt $count; $i++) { if ([object]::ReferenceEquals($elements[$i], $c)) { $index = $i } }
            $pipeId = $pipe.Extent.StartOffset
            if ($index -gt 0) {
                $before = $elements[$index - 1]
                if ($before -is [System.Management.Automation.Language.CommandAst]) { $prev = 'command' } else { $prev = 'expression' }
            }
        }
        # Where it sits: at the top of the script (its statements run in order), or inside a
        # script block, a branch, a loop or a pipeline chain (it may run any number of times).
        $top = $false
        if ($pipe -is [System.Management.Automation.Language.PipelineAst]) {
            $block = $pipe.Parent
            if ($block -is [System.Management.Automation.Language.NamedBlockAst] -and [object]::ReferenceEquals($block.Parent, $ast)) { $top = $true }
        }
        $inBlock = $false
        $p = $c.Parent
        while ($null -ne $p) {
            if ($p -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { $inBlock = $true }
            $p = $p.Parent
        }
        $redirects = @()
        foreach ($r in $c.Redirections) {
            if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) {
                $redirects += @{ file = (El $r.Location); append = [bool]$r.Append }
            }
        }
        $els = @($c.CommandElements)
        $commands += @{
            name = [string]$c.GetCommandName()
            first = (El $els[0])
            inv = [string]$c.InvocationOperator
            args = @($els | Select-Object -Skip 1 | ForEach-Object { El $_ })
            pipe = $pipeId
            index = $index
            count = $count
            prev = $prev
            top = $top
            inBlock = $inBlock
            redirects = @($redirects)
            start = $c.Extent.StartOffset
        }
    }
    # Pipelines that start with an expression ('C:\x' | Remove-Item) are found through `prev`.
    # Redirections of expressions ("x" > file) are statements of their own.
    $exprRedirects = @()
    $exprs = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandExpressionAst] }, $true)
    foreach ($x in $exprs) {
        foreach ($r in $x.Redirections) {
            if ($r -is [System.Management.Automation.Language.FileRedirectionAst]) {
                $exprRedirects += @{ file = (El $r.Location); append = [bool]$r.Append }
            }
        }
    }
    $members = @()
    $calls = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)
    foreach ($m in $calls) {
        $type = ''
        if ($m.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $type = [string]$m.Expression.TypeName.FullName }
        $member = ''
        if ($m.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $member = [string]$m.Member.Value }
        $members += @{ type = $type; member = $member; static = [bool]$m.Static; text = (Cut $m.Extent.Text) }
    }
    $assigned = @()
    $assignments = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true)
    foreach ($a in $assignments) { $assigned += (Cut $a.Left.Extent.Text) }
    $chains = $ast.FindAll({ param($n) $n.GetType().Name -eq 'PipelineChainAst' }, $true)
    $functions = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    return @{
        ok = $true
        commands = @($commands)
        exprRedirects = @($exprRedirects)
        members = @($members)
        assigned = @($assigned)
        chains = @($chains).Count
        functions = @($functions).Count
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    try {
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))
        $answer = Describe $text
    } catch {
        $answer = @{ ok = $false; error = (Cut ('the parse helper failed: ' + $_.Exception.Message)) }
    }
    [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress -Depth 30))
    [Console]::Out.Flush()
}
