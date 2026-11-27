namespace Anemo.Desktop.Core.Permissions;

/// <summary>
/// Deletes to the Recycle Bin (docs/specs/25-device-permission-profiles.md §8): when every delete
/// of a command is in work folders with "Recycle Bin" on, the shell starts with this prelude. It
/// defines a <c>Remove-Item</c> function, which PowerShell finds before the cmdlet, so
/// <c>rm</c>, <c>del</c>, <c>ri</c>, <c>erase</c>, <c>rd</c> and <c>rmdir</c> (aliases of that
/// name) recycle too.
///
/// It is not a security boundary: the analyser already allowed the delete; this only makes
/// ordinary deletes reversible. <c>cmd /c del</c>, <c>git clean</c> and the like stay permanent.
/// A file larger than the Recycle Bin would keep (taken as 5% of its drive) is refused with an
/// error rather than deleted for good.
/// </summary>
public static class RecyclePrelude
{
    public const string Script = """
Add-Type -AssemblyName Microsoft.VisualBasic
function Remove-Item {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [Parameter(Position = 0, ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
        [Alias('FullName')] [string[]] $Path,
        [Parameter(ValueFromPipelineByPropertyName = $true)] [Alias('PSPath', 'LP')] [string[]] $LiteralPath,
        [switch] $Recurse, [switch] $Force, [string] $Filter, [string[]] $Include, [string[]] $Exclude
    )
    process {
        $items = @()
        if ($LiteralPath) { $items += Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop }
        if ($Path) { $items += Get-Item -Path $Path -Force:$Force -ErrorAction Stop }
        foreach ($item in $items) {
            $full = $item.FullName
            if (-not $PSCmdlet.ShouldProcess($full, 'Move to the Recycle Bin')) { continue }
            $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
            $limit = [long]($drive.TotalSize * 0.05)
            if ($item.PSIsContainer) {
                $size = (Get-ChildItem -LiteralPath $full -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
                if ($size -gt $limit) { Write-Error "$full is too large for the Recycle Bin, so it was not deleted." ; continue }
                if (-not $Recurse -and (Get-ChildItem -LiteralPath $full -Force | Select-Object -First 1)) {
                    Write-Error "$full is not empty: add -Recurse to delete it." ; continue
                }
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($full, 'OnlyErrorDialogs', 'SendToRecycleBin')
            } else {
                if ($item.Length -gt $limit) { Write-Error "$full is too large for the Recycle Bin, so it was not deleted." ; continue }
                [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($full, 'OnlyErrorDialogs', 'SendToRecycleBin')
            }
        }
    }
}

""";
}
