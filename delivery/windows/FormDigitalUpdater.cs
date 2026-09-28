using System;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal sealed class FormDigitalUpdater : Form
{
    private readonly Label status = new Label();
    private readonly Button retry = new Button();
    private readonly Button choose = new Button();
    private readonly Button close = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private string target;
    private readonly string launcherMutex;
    private bool busy;
    private static string Ui(string traditional, string simplified, string english)
    {
        string lang = CultureInfo.CurrentUICulture.Name;
        return lang.StartsWith("zh-TW") || lang.StartsWith("zh-HK") || lang.StartsWith("zh-MO") ? traditional : lang.StartsWith("zh") ? simplified : english;
    }
    [STAThread] private static void Main()
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new FormDigitalUpdater());
    }
    private FormDigitalUpdater() : this(null, "Local\\FormDigitalDesktopLauncher") { }
    // The production entry point always uses the launcher mutex. The test
    // assembly supplies its own mutex and an isolated program folder.
    internal FormDigitalUpdater(string testTarget, string mutexName)
    {
        target = testTarget; launcherMutex = mutexName;
        Text = Ui("Form Digital 更新工具", "Form Digital 更新工具", "Form Digital Updater") + " " + FormDigitalUpdateEngine.Manifest().version;
        ClientSize = new Size(600, 255); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft JhengHei", 10);
        status.SetBounds(24, 22, 552, 132); status.Text = Ui("正在尋找 Form Digital…", "正在查找 Form Digital…", "Looking for Form Digital…");
        progress.SetBounds(24, 165, 552, 16);
        retry.SetBounds(24, 202, 150, 34); retry.Text = Ui("重試更新", "重试更新", "Retry update"); retry.Click += delegate { BeginUpdate(); };
        choose.SetBounds(185, 202, 195, 34); choose.Text = Ui("選擇程式資料夾", "选择程序文件夹", "Choose program folder");
        choose.Click += delegate { SelectFolder(); };
        close.SetBounds(426, 202, 150, 34); close.Text = Ui("關閉", "关闭", "Close"); close.Click += delegate { Close(); };
        Controls.AddRange(new Control[] { status, progress, retry, choose, close });
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
        Shown += delegate {
            if (target != null) { BeginUpdate(); return; }
            string here = AppDomain.CurrentDomain.BaseDirectory;
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string[] candidates = { here, Path.Combine(here, "Form Digital 交付包"), Path.Combine(desktop, "Form Digital 交付包"), Path.Combine(desktop, "Kenny Form", "Form Digital 交付包") };
            foreach (string candidate in candidates)
                if (File.Exists(Path.Combine(candidate, "Form Digital.exe"))) { target = candidate; break; }
            if (target == null) SelectFolder(); else BeginUpdate();
        };
    }
    private void SelectFolder()
    {
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = Ui("選擇原有交付包：內有 Form Digital.exe、app 及 runtime。", "选择原交付包：内有 Form Digital.exe、app 和 runtime。", "Choose your existing package folder containing Form Digital.exe, app and runtime.");
            dialog.ShowNewFolderButton = false;
            if (dialog.ShowDialog(this) == DialogResult.OK) { target = dialog.SelectedPath; BeginUpdate(); }
            else status.Text = Ui("尚未更新。選擇程式資料夾後便可繼續。", "尚未更新。选择程序文件夹后即可继续。", "No update was made. Choose the program folder to continue.");
        }
    }
    private void BeginUpdate()
    {
        if (busy) return;
        if (target == null) { SelectFolder(); return; }
        busy = true; retry.Enabled = choose.Enabled = close.Enabled = false; progress.Style = ProgressBarStyle.Marquee;
        status.Text = Ui("正在檢查更新檔…", "正在检查更新文件…", "Checking the update…") + "\n\n" + target;
        ThreadPool.QueueUserWorkItem(delegate {
            string result; bool success = false;
            using (var mutex = new Mutex(false, launcherMutex))
            {
                bool acquired = false;
                try
                {
                    try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) throw new IOException("RUNNING");
                    FormDigitalUpdateEngine.Apply(target, delegate(string phase) {
                        if (phase == "installing") BeginInvoke((Action)delegate { status.Text = Ui("正在更新程式，請稍候。原有資料及設定會保留。", "正在更新程序，请稍候。原有数据和设置会保留。", "Updating the program. Your existing data and settings are kept.") + "\n\n" + target; });
                    });
                    success = true;
                    result = Ui("更新完成，可以關閉此視窗。\n\n請重新開啟原有的 Form Digital.exe，並重新整理網站。已產生的 PDF 不會改動，請重新匯出。", "更新完成，可以关闭此窗口。\n\n请重新打开原有的 Form Digital.exe，并刷新网站。已有 PDF 不会改变，请重新导出。", "Update complete. You can close this window.\n\nOpen your usual Form Digital.exe and refresh the site. Export new PDFs to use the fixes; existing PDFs stay unchanged.");
                }
                catch (Exception error)
                {
                    result = error.Message == "RUNNING" || error.Message.StartsWith("Save your work")
                        ? Ui("請先儲存工作並關閉 Form Digital 啟動視窗，再按「重試更新」。目前尚未替換程式。", "请先保存工作并关闭 Form Digital 启动窗口，再按“重试更新”。目前尚未替换程序。", "Save your work and close the Form Digital launcher, then retry. No program files were replaced.")
                        : Ui("更新未完成。請保留程式資料夾，重試或把以下訊息交給維護人員：\n\n", "更新未完成。请保留程序文件夹，重试或把以下信息交给维护人员：\n\n", "The update did not finish. Keep the program folder, retry or send this message to the maintainer:\n\n") + error.Message;
                }
                finally { if (acquired) mutex.ReleaseMutex(); }
            }
            BeginInvoke((Action)delegate { busy = false; progress.Style = ProgressBarStyle.Blocks; progress.Value = success ? 100 : 0; status.Text = result; close.Enabled = true; retry.Enabled = choose.Enabled = !success; });
        });
    }
}
