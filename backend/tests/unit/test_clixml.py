"""PowerShell CLIXML on stderr becomes plain text (computer_shell)."""

from app.tools import clixml

# Captured on Windows 11 from `powershell.exe -NoProfile -NonInteractive -OutputFormat Text
# -EncodedCommand ...` with stderr redirected, as Anemo Desktop runs it.
ERROR_SAMPLE = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="Error">Get-Item : Cannot find path \'C:\\does-not-exist\' because it does not exist._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S><S S="Error">+ Get-Item C:\\does-not-exist; Write-Warning \'careful\'; Write-Error \'sec ..._x000D__x000A_</S><S S="Error">+ ~~~~~~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : ObjectNotFound: (C:\\does-not-exist:String) [Get-Item], ItemNotFoundException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S><Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="warning">careful</S><S S="Error">Get-Item C:\\does-not-exist; Write-Warning \'careful\'; Write-Error \'second &lt;one&gt; &amp; more\' : second &lt;one&gt; &amp; more_x000D__x000A_</S><S S="Error">    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>'  # noqa: E501

PROGRESS_SAMPLE = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">0</I64><PR N="Record"><AV>Working</AV><AI>0</AI><Nil /><PI>-1</PI><PC>30</PC><T>Processing</T><SR>-1</SR><SD>Processing</SD></PR></MS></Obj><Obj S="progress" RefId="2"><TNRef RefId="0" /><MS><I64 N="SourceId">0</I64><PR N="Record"><AV>Working</AV><AI>0</AI><Nil /><PI>-1</PI><PC>60</PC><T>Processing</T><SR>-1</SR><SD>Processing</SD></PR></MS></Obj><Obj S="progress" RefId="3"><TNRef RefId="0" /><MS><I64 N="SourceId">0</I64><PR N="Record"><AV>Working</AV><AI>0</AI><Nil /><PI>-1</PI><PC>90</PC><T>Processing</T><SR>-1</SR><SD>Processing</SD></PR></MS></Obj><S S="Error">1..3 | % { Write-Progress -Activity \'Working\' -PercentComplete ($_*30) }; Write-Error \'done\'; Write-Verbose \'v\' _x000D__x000A_</S><S S="Error">-Verbose : done_x000D__x000A_</S><S S="Error">    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S><S S="verbose">v</S></Objs>'  # noqa: E501


def test_errors_and_warnings_read_as_powershell_prints_them():
    text = clixml.decode(ERROR_SAMPLE)
    assert "<Objs" not in text and "_x000D_" not in text and "progress" not in text
    assert text.startswith(
        "Get-Item : Cannot find path 'C:\\does-not-exist' because it does not exist.\n"
    )
    assert "\nWARNING: careful\n" in text
    assert "second <one> & more" in text  # XML entities decoded
    assert "Preparing modules" not in text  # progress records dropped
    assert len(text) * 2 < len(ERROR_SAMPLE)


def test_progress_is_dropped_and_verbose_is_marked():
    text = clixml.decode(PROGRESS_SAMPLE)
    assert "Processing" not in text and "Preparing" not in text
    assert text.rstrip().endswith("VERBOSE: v")
    assert len(text) * 3 < len(PROGRESS_SAMPLE)


def test_plain_text_is_unchanged_and_text_around_a_block_is_kept():
    assert clixml.decode("just text\r\n") == "just text\r\n"
    text = clixml.decode("before\n" + ERROR_SAMPLE + "after")
    assert text.startswith("before\nGet-Item") and text.endswith("after")


def test_a_block_cut_off_at_the_end_is_decoded_as_far_as_it_goes():
    cut = ERROR_SAMPLE[: ERROR_SAMPLE.index("CategoryInfo") + 30]
    text = clixml.decode(cut)
    assert "<S" not in text and "Cannot find path" in text and "CategoryInfo" in text
