using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.Tests;

public sealed class SettingsDraftTests
{
    private static readonly DesktopSettings Current = new()
    {
        Address = "https://anemo.example.com",
        ProtectedToken = "protected",
        PausedUntil = new DateTimeOffset(2026, 11, 23, 15, 30, 0, TimeSpan.Zero),
        GitHubOwner = "someone",
        CodeProjectsFolder = @"D:\code",
    };

    [Fact]
    public void Unchanged_settings_save_as_they_were()
    {
        var check = SettingsDraft.From(Current).Check(Current);

        Assert.True(check.Ok);
        Assert.Equal(Current, check.Settings);
        Assert.Null(check.NewToken);
    }

    [Fact]
    public void A_pasted_token_is_trimmed_and_the_rest_is_kept()
    {
        var draft = SettingsDraft.From(Current) with { Token = "  anemo_abc  ", WorkFolder = "  C:\\work  ", GitHubOwner = " " };

        var check = draft.Check(Current);

        Assert.Equal("anemo_abc", check.NewToken);
        Assert.Equal(@"C:\work", check.Settings!.WorkFolder);
        Assert.Null(check.Settings.GitHubOwner);
        Assert.Equal(Current.PausedUntil, check.Settings.PausedUntil);
        Assert.Equal("protected", check.Settings.ProtectedToken);
    }

    [Theory]
    [InlineData("ftp://anemo.example.com", SettingsField.Address)]
    [InlineData("http://anemo.example.com", SettingsField.Address)]
    [InlineData("", SettingsField.Address)]
    public void A_bad_address_points_at_the_address(string address, SettingsField field)
    {
        var check = (SettingsDraft.From(Current) with { Address = address }).Check(Current);

        Assert.False(check.Ok);
        Assert.Equal(field, check.Problem!.Field);
        Assert.StartsWith("The address must start with https://", check.Problem.Message);
    }

    [Fact]
    public void Each_problem_points_at_its_field()
    {
        var draft = SettingsDraft.From(Current);

        Assert.Equal(SettingsField.Token, (draft with { Token = "sk-123" }).Check(Current).Problem!.Field);
        Assert.Equal(SettingsField.StopKey, (draft with { StopHotkey = "S" }).Check(Current).Problem!.Field);
        Assert.Equal(SettingsField.ShareKey, (draft with { ShareHotkey = "Shift+A" }).Check(Current).Problem!.Field);
        Assert.Equal(SettingsField.GitHubOwner, (draft with { GitHubOwner = "not an owner" }).Check(Current).Problem!.Field);
    }

    [Fact]
    public void The_two_keys_must_differ()
    {
        var check = (SettingsDraft.From(Current) with { StopHotkey = "Ctrl+Alt+K", ShareHotkey = "alt+ctrl+k" }).Check(Current);

        Assert.Equal(SettingsField.ShareKey, check.Problem!.Field);
        Assert.Equal("The stop key and the share key must differ.", check.Problem.Message);
    }

    [Fact]
    public void Keys_are_saved_in_their_usual_spelling()
    {
        var check = (SettingsDraft.From(Current) with { StopHotkey = "shift+ctrl+alt+q" }).Check(Current);

        Assert.Equal("Ctrl+Alt+Shift+Q", check.Settings!.StopHotkey);
    }

    [Fact]
    public void Automatic_updates_are_on_by_default_and_can_be_turned_off()
    {
        Assert.True(new DesktopSettings().AutoUpdate);
        Assert.True(SettingsDraft.From(Current).AutoUpdate);

        var check = (SettingsDraft.From(Current) with { AutoUpdate = false }).Check(Current);

        Assert.False(check.Settings!.AutoUpdate);
        Assert.True((SettingsDraft.From(check.Settings) with { AutoUpdate = true }).Check(check.Settings).Settings!.AutoUpdate);
    }
}
