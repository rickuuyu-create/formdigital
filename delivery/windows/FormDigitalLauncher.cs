using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal sealed class FormDigitalLauncher : Form
{
    private static readonly string uiLocale = SelectLocale();
    private static string SelectLocale()
    {
        string overrideLocale = Environment.GetEnvironmentVariable("FORMDIGITAL_LAUNCHER_LOCALE");
        if (overrideLocale == "zh-Hant" || overrideLocale == "zh-Hans" || overrideLocale == "en") return overrideLocale;
        string culture = CultureInfo.CurrentUICulture.Name;
        if (culture.StartsWith("zh-TW", StringComparison.OrdinalIgnoreCase) || culture.StartsWith("zh-HK", StringComparison.OrdinalIgnoreCase) || culture.StartsWith("zh-MO", StringComparison.OrdinalIgnoreCase)) return "zh-Hant";
        if (culture.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) return "zh-Hans";
        return "en";
    }
    private static string Ui(string traditional, string simplified, string english)
    {
        return uiLocale == "zh-Hant" ? traditional : uiLocale == "zh-Hans" ? simplified : english;
    }
    private readonly Label status = new Label();
    private readonly Button openButton = new Button();
    private readonly Button guideButton = new Button();
    private Process supervisor;
    private IntPtr job = IntPtr.Zero;
    private bool ready;
    private bool closing;
    private readonly string root;
    private readonly string app;
    private readonly string node;
    private readonly string config;
    private readonly int webPort;
    private readonly int ldsPort;
    private readonly Mutex singleton;
    private readonly object gate = new object();

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedJobInfo
    {
        public JobLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedJobInfo info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    private static void Main()
    {
        bool newInstance;
        Mutex mutex = new Mutex(true, "Local\\FormDigitalDesktopLauncher", out newInstance);
        if (!newInstance)
        {
            try { Process.Start(new ProcessStartInfo("http://localhost:3210/") { UseShellExecute = true }); }
            catch { MessageBox.Show(Ui("Form Digital 已經開啟，請返回原有視窗。", "Form Digital 已经打开，请返回原窗口。", "Form Digital is already open. Return to the existing window."), "Form Digital"); }
            mutex.Dispose();
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new FormDigitalLauncher(mutex)); }
        finally { mutex.ReleaseMutex(); mutex.Dispose(); }
    }

    private FormDigitalLauncher(Mutex mutex)
    {
        singleton = mutex;
        root = AppDomain.CurrentDomain.BaseDirectory;
        app = Path.Combine(root, "app");
        node = Path.Combine(root, "runtime", "node.exe");
        string settings = Environment.GetEnvironmentVariable("FORMDIGITAL_LOCAL_CONFIG");
        config = String.IsNullOrWhiteSpace(settings) ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FormDigital", "offline-config.json") : Path.GetFullPath(settings);
        int parsed;
        webPort = Int32.TryParse(Environment.GetEnvironmentVariable("FORMDIGITAL_WEB_PORT"), out parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3210;
        ldsPort = Int32.TryParse(Environment.GetEnvironmentVariable("FORMDIGITAL_LDS_HEALTH_PORT"), out parsed) && parsed > 0 && parsed <= 65535 ? parsed : 43210;
        Text = "Form Digital";
        Size = new Size(490, 220);
        MinimumSize = new Size(490, 220);
        MaximumSize = new Size(700, 220);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font(uiLocale == "zh-Hant" ? "Microsoft JhengHei" : uiLocale == "zh-Hans" ? "Microsoft YaHei" : "Segoe UI", 10);
        status.Text = Ui("正在準備 Form Digital…", "正在准备 Form Digital…", "Preparing Form Digital…");
        status.Location = new Point(24, 22);
        status.Size = new Size(420, 76);
        status.AutoEllipsis = true;
        Controls.Add(status);
        openButton.Text = Ui("開啟網站", "打开网站", "Open website");
        openButton.Location = new Point(24, 118);
        openButton.Size = new Size(125, 35);
        openButton.Enabled = false;
        openButton.Click += delegate { OpenSite(); };
        Controls.Add(openButton);
        guideButton.Text = Ui("使用說明", "使用说明", "User guide");
        guideButton.Location = new Point(165, 118);
        guideButton.Size = new Size(145, 35);
        guideButton.Click += delegate { OpenGuide(); };
        Controls.Add(guideButton);
        Shown += delegate { ThreadPool.QueueUserWorkItem(delegate { StartRuntime(); }); };
        FormClosing += delegate { lock (gate) { closing = true; if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; } } };
    }

    private void ShowStatus(string message)
    {
        if (!IsHandleCreated || IsDisposed || closing) return;
        try { BeginInvoke((Action)delegate { if (!closing) status.Text = message; }); }
        catch (InvalidOperationException) {}
    }
    private void OpenSite()
    {
        if (!ready) return;
        try { Process.Start(new ProcessStartInfo("http://localhost:" + webPort + "/") { UseShellExecute = true }); }
        catch { ShowStatus(Ui("網站已啟動，但無法自動開啟瀏覽器。請在瀏覽器輸入 ", "网站已启动，但无法自动打开浏览器。请在浏览器输入 ", "The site is running, but the browser did not open. Enter ") + "http://localhost:" + webPort + "/"); }
    }
    private void OpenGuide()
    {
        string guideName = uiLocale == "zh-Hans" ? "首次使用说明.zh-Hans.txt" : uiLocale == "en" ? "First-use-guide.en.txt" : "首次使用說明.txt";
        try { Process.Start(new ProcessStartInfo(Path.Combine(root, guideName)) { UseShellExecute = true }); }
        catch { MessageBox.Show(Ui("請開啟交付包內的「首次使用說明.txt」。", "请打开交付包内的「首次使用说明.zh-Hans.txt」。", "Open First-use-guide.en.txt in the package folder."), "Form Digital"); }
    }
    private ProcessStartInfo NodeCommand(string script)
    {
        ProcessStartInfo info = new ProcessStartInfo(node, "\"" + script + "\"");
        info.WorkingDirectory = app;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.EnvironmentVariables["FORMDIGITAL_LOCAL_CONFIG"] = config;
        info.EnvironmentVariables["FORMDIGITAL_LOCAL_ONLY"] = "1";
        info.EnvironmentVariables["FORMDIGITAL_WEB_PORT"] = webPort.ToString();
        info.EnvironmentVariables["FORMDIGITAL_LDS_HEALTH_PORT"] = ldsPort.ToString();
        info.EnvironmentVariables.Remove("DOTENV_CONFIG_PATH");
        info.EnvironmentVariables.Remove("GOOGLE_OAUTH_CLIENT_ID");
        info.EnvironmentVariables.Remove("GOOGLE_OAUTH_CLIENT_SECRET");
        info.EnvironmentVariables.Remove("GOOGLE_OAUTH_REDIRECT_URIS");
        info.EnvironmentVariables.Remove("GOOGLE_OAUTH_REDIRECT_URI");
        info.EnvironmentVariables.Remove("JWT_SECRET");
        info.EnvironmentVariables.Remove("FORMDIGITAL_ENABLE_TEST_HOOKS");
        return info;
    }
    private void StartRuntime()
    {
        try
        {
            if (!File.Exists(node) || !File.Exists(Path.Combine(app, "dist", "index.js")))
                throw new Exception(Ui("交付包檔案不完整。請重新複製整個「Form Digital 交付包」資料夾。", "交付包文件不完整，请重新复制整个文件夹。", "The package is incomplete. Copy the entire Form Digital package folder again."));
            using (Process setup = Process.Start(NodeCommand("scripts/initialize-delivery.mjs")))
            {
                if (!setup.WaitForExit(20000)) { setup.Kill(); throw new Exception(Ui("初次設定逾時。請檢查資料夾是否可寫入。", "首次设置超时，请检查文件夹是否可写。", "Initial setup timed out. Check that the folder is writable.")); }
                if (setup.ExitCode != 0) throw new Exception(Ui("本機設定無法建立。請檢查 Windows 使用者資料夾是否可寫入。", "无法创建本地设置，请检查 Windows 用户文件夹是否可写。", "Local settings could not be created. Check your Windows user folder permissions."));
            }
            ShowStatus(Ui("正在啟動本機網站與資料服務…", "正在启动本地网站和数据服务…", "Starting the local site and data service…"));
            if (closing) return;
            supervisor = new Process();
            supervisor.StartInfo = NodeCommand("scripts/start-production-runtime.mjs");
            supervisor.EnableRaisingEvents = true;
            supervisor.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                if (e.Data.Contains("READY. Open"))
                {
                    ready = true;
                    ShowStatus(Ui("網站已啟動，可直接使用。關閉此視窗會停止服務。", "网站已启动，可以直接使用。关闭此窗口会停止服务。", "The site is ready. Closing this window stops the service."));
                    if (!closing) try { BeginInvoke((Action)delegate {
                        if (!closing) {
                            openButton.Enabled = true;
                            if (Environment.GetEnvironmentVariable("FORMDIGITAL_NO_BROWSER") != "1") OpenSite();
                        }
                    }); } catch (InvalidOperationException) {}
                }
                else if (e.Data.Contains("ERROR:")) ShowStatus(e.Data.Substring(e.Data.IndexOf("ERROR:") + 6).Trim());
            };
            supervisor.Exited += delegate
            {
                ready = false;
                if (!closing) ShowStatus(Ui("網站服務已停止。請關閉此視窗後重試；如再次發生，請聯絡維護人員。", "网站服务已停止。请关闭此窗口后重试；如果问题再次出现，请联系维护人员。", "The site has stopped. Close this window and try again; contact the maintainer if it happens again."));
            };
            lock (gate)
            {
                if (closing) return;
                if (!supervisor.Start()) throw new Exception(Ui("無法啟動網站服務。", "无法启动网站服务。", "Could not start the site."));
                job = CreateJobObject(IntPtr.Zero, null);
                ExtendedJobInfo limits = new ExtendedJobInfo();
                limits.BasicLimitInformation.LimitFlags = 0x2000;
                if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedJobInfo))) || !AssignProcessToJobObject(job, supervisor.Handle))
                {
                    supervisor.Kill();
                    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
                    throw new Exception(Ui("無法建立安全的服務管理程序。請聯絡維護人員。", "无法创建安全的服务管理进程，请联系维护人员。", "Could not start the service manager. Contact the maintainer."));
                }
                supervisor.BeginOutputReadLine();
                supervisor.BeginErrorReadLine();
            }
        }
        catch (Exception error) { ShowStatus(error.Message); }
    }
}
