using System;
using System.Drawing;
using System.Windows.Forms;
using Anemo.Desktop.Core.CodeJobs;
using Anemo.Desktop.Core.Connection;
using Anemo.Desktop.Core.Control;
using Anemo.Desktop.Core.Storage;

namespace Anemo.Desktop.UI;

/// <summary>
/// The Settings window: Anemo's address, the device token (never shown again once saved),
/// PowerShell, its working folder, the two hotkeys, "Start with Windows" and sharing Claude
/// Code jobs.
/// </summary>
internal sealed class SettingsForm : Form
{
    private readonly TextBox _address = new() { Width = 360 };
    private readonly TextBox _token = new() { Width = 360, UseSystemPasswordChar = true };
    private readonly CheckBox _powerShell = new()
    {
        Text = "Allow PowerShell on this computer (used only when the device is trusted in Anemo)",
        AutoSize = true,
    };

    private readonly TextBox _workFolder = new() { Width = 360 };
    private readonly TextBox _stopKey = new() { Width = 200 };
    private readonly TextBox _shareKey = new() { Width = 200 };
    private readonly CheckBox _startWithWindows = new() { Text = "Start with Windows", AutoSize = true };
    private readonly CheckBox _shareCodeJobs = new() { Text = "Share Claude Code jobs with Anemo", AutoSize = true };
    private readonly TextBox _codeJobsFolder = new() { Width = 360 };
    private readonly CheckBox _startCodeJobs = new() { Text = "Let Anemo start Claude Code jobs", AutoSize = true };
    private readonly TextBox _projectsFolder = new() { Width = 360 };
    private readonly TextBox _gitHubOwner = new() { Width = 300 };
    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.Firebrick };
    private readonly DesktopSettings _current;
    private readonly Func<DesktopSettings, string?, string?> _save;

    /// <param name="saveSettings">Saves the settings and new token; returns a sentence when that failed.</param>
    public SettingsForm(
        DesktopSettings current, bool hasToken, string status, string defaultWorkFolder, Func<DesktopSettings, string?, string?> saveSettings)
    {
        _current = current;
        _save = saveSettings;
        Text = "Anemo Desktop settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(12);

        _address.Text = current.Address ?? "";
        _address.PlaceholderText = "https://anemo.example.com";
        _token.PlaceholderText = hasToken ? "A token is saved; paste a new one to replace it" : "anemo_…";
        _powerShell.Checked = current.PowerShellEnabled;
        _workFolder.Text = current.WorkFolder ?? "";
        _workFolder.PlaceholderText = defaultWorkFolder;
        _stopKey.Text = current.StopHotkey;
        _shareKey.Text = current.ShareHotkey;
        _startWithWindows.Checked = current.StartWithWindows;
        _shareCodeJobs.Checked = current.ShareCodeJobs;
        _codeJobsFolder.Text = current.CodeJobsFolder ?? "";
        _codeJobsFolder.PlaceholderText = CodeJobLimits.DefaultFolder;
        _startCodeJobs.Checked = current.StartCodeJobs;
        _projectsFolder.Text = current.CodeProjectsFolder ?? "";
        _projectsFolder.PlaceholderText = CodeJobLimits.DefaultProjectsFolder;
        _gitHubOwner.Text = current.GitHubOwner ?? "";
        _gitHubOwner.PlaceholderText = "the account gh is signed in as";
        _startCodeJobs.Enabled = _shareCodeJobs.Checked; // a job Anemo starts must be visible to it
        _shareCodeJobs.CheckedChanged += (_, _) => _startCodeJobs.Enabled = _shareCodeJobs.Checked;

        var grid = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill };
        void Row(string label, Control control)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Padding = new Padding(0, 6, 8, 0) });
            grid.Controls.Add(control);
        }

        Row("Anemo address", _address);
        Row("Device token", _token);
        grid.Controls.Add(new Label());
        grid.Controls.Add(new Label
        {
            Text = "Make the token in Anemo: Settings → Devices → Add a device (kind: computer).",
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
        });
        grid.Controls.Add(new Label());
        grid.Controls.Add(_powerShell);
        Row("PowerShell folder", _workFolder);
        Row("Stop key", _stopKey);
        Row("Share key", _shareKey);
        grid.Controls.Add(new Label());
        grid.Controls.Add(_startWithWindows);
        grid.Controls.Add(new Label());
        grid.Controls.Add(_shareCodeJobs);
        grid.Controls.Add(new Label());
        grid.Controls.Add(new Label
        {
            Text = "The jobs' prompts, tool calls and output are sent to Anemo, only while this computer is trusted there.",
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            ForeColor = SystemColors.GrayText,
        });
        Row("Jobs folder", _codeJobsFolder);
        grid.Controls.Add(new Label());
        grid.Controls.Add(_startCodeJobs);
        grid.Controls.Add(new Label());
        grid.Controls.Add(new Label
        {
            Text = "Jobs run with --permission-mode bypassPermissions, so Anemo's agents can run anything Claude Code can on this computer. Only while sharing is on and this computer is trusted.",
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            ForeColor = SystemColors.GrayText,
        });
        Row("Projects folder", _projectsFolder);
        Row("GitHub owner", _gitHubOwner);
        grid.Controls.Add(new Label { Text = "Status", AutoSize = true, Padding = new Padding(0, 6, 8, 0) });
        grid.Controls.Add(new Label { Text = status, AutoSize = true, MaximumSize = new Size(420, 0), Padding = new Padding(0, 6, 0, 0) });
        grid.Controls.Add(new Label());
        grid.Controls.Add(_error);

        var save = new Button { Text = "Save", AutoSize = true, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
        save.Click += (_, _) => TrySave(save);
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(save);
        grid.Controls.Add(new Label());
        grid.Controls.Add(buttons);

        Controls.Add(grid);
        AcceptButton = save;
        CancelButton = cancel;
    }

    /// <summary>The settings to save, after OK.</summary>
    public DesktopSettings? Result { get; private set; }

    private void TrySave(Button save)
    {
        if (AnemoAddress.Parse(_address.Text) is null)
        {
            _error.Text = "The address must start with https:// (plain http only for this computer).";
            return;
        }

        var token = _token.Text.Trim();
        if (token.Length > 0 && !token.StartsWith("anemo_", StringComparison.Ordinal))
        {
            _error.Text = "A device token starts with anemo_.";
            return;
        }

        var stop = Hotkey.Parse(_stopKey.Text);
        var share = Hotkey.Parse(_shareKey.Text);
        if (stop is null || share is null)
        {
            _error.Text = "Keys look like Ctrl+Alt+Shift+S: two or more of Ctrl, Alt, Shift, Win, then a letter, digit or F1–F12.";
            return;
        }

        if (stop == share)
        {
            _error.Text = "The stop key and the share key must differ.";
            return;
        }

        var owner = _gitHubOwner.Text.Trim();
        if (owner.Length > 0 && !CodeProjects.IsOwner(owner))
        {
            _error.Text = "The GitHub owner is a GitHub user or organisation name: letters, digits and dashes.";
            return;
        }

        var result = _current with
        {
            Address = AnemoAddress.Parse(_address.Text)!.ToString(),
            PowerShellEnabled = _powerShell.Checked,
            WorkFolder = string.IsNullOrWhiteSpace(_workFolder.Text) ? null : _workFolder.Text.Trim(),
            StopHotkey = stop.ToString(),
            ShareHotkey = share.ToString(),
            StartWithWindows = _startWithWindows.Checked,
            ShareCodeJobs = _shareCodeJobs.Checked,
            CodeJobsFolder = string.IsNullOrWhiteSpace(_codeJobsFolder.Text) ? null : _codeJobsFolder.Text.Trim(),
            StartCodeJobs = _startCodeJobs.Checked,
            CodeProjectsFolder = string.IsNullOrWhiteSpace(_projectsFolder.Text) ? null : _projectsFolder.Text.Trim(),
            GitHubOwner = owner.Length == 0 ? null : owner,
        };
        var newToken = token.Length > 0 ? token : null;
        if (_save(result, newToken) is { } problem)
        {
            _error.Text = problem; // e.g. Windows couldn't protect the token: the window stays open
            return;
        }

        Result = result;
        save.DialogResult = DialogResult.OK;
        DialogResult = DialogResult.OK;
        Close();
    }
}
