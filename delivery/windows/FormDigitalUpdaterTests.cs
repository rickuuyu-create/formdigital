using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Threading;
using System.Globalization;
using System.Windows.Forms;

internal static class FormDigitalUpdaterTests
{
    private static string reference, suite;
    private static int passed;
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static string Fixture(string name)
    {
        string root = Path.Combine(suite, name); Directory.CreateDirectory(root);
        foreach (var file in FormDigitalUpdateEngine.Manifest().baseFiles)
        {
            string target = FormDigitalUpdateEngine.SafePath(root, file.Key);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.Copy(Path.Combine(reference, file.Key.Replace('/', Path.DirectorySeparatorChar)), target);
        }
        Directory.CreateDirectory(Path.Combine(root, "runtime"));
        File.WriteAllText(Path.Combine(root, "runtime", "node.exe"), "synthetic runtime marker");
        File.WriteAllText(Path.Combine(root, "Form Digital.exe"), "synthetic launcher marker");
        Directory.CreateDirectory(Path.Combine(root, "app", "dist"));
        File.WriteAllText(Path.Combine(root, "app", "dist", "index.js"), "old program");
        Directory.CreateDirectory(Path.Combine(root, "Data"));
        File.WriteAllText(Path.Combine(root, "Data", "sentinel.json"), "synthetic form: unchanged");
        File.WriteAllText(Path.Combine(root, "app", "local-service-config.json"), "synthetic config: unchanged");
        return root;
    }
    private static void Preserved(string root)
    {
        Check(File.ReadAllText(Path.Combine(root, "Data", "sentinel.json")) == "synthetic form: unchanged", "Data changed");
        Check(File.ReadAllText(Path.Combine(root, "app", "local-service-config.json")) == "synthetic config: unchanged", "Config changed");
        Check(File.ReadAllText(Path.Combine(root, "runtime", "node.exe")) == "synthetic runtime marker", "Runtime changed");
    }
    private static void Test(string name, Action test)
    {
        test(); passed++; Console.WriteLine("PASS " + name);
    }
    private static void MustFail(Action test)
    {
        bool failed = false; try { test(); } catch { failed = true; }
        Check(failed, "Expected refusal or rollback");
    }
    private static void CheckWindow(string root, bool blocked)
    {
        string name = "Local\\FormDigitalUpdaterTest-" + Guid.NewGuid().ToString("N");
        using (var held = new Mutex(blocked, name))
        using (var window = new FormDigitalUpdater(root, name))
        using (var timer = new System.Windows.Forms.Timer())
        {
            window.Opacity = 0; window.ShowInTaskbar = false;
            DateTime deadline = DateTime.UtcNow.AddSeconds(30);
            string final = null;
            timer.Interval = 100;
            timer.Tick += delegate {
                string text = window.Controls.OfType<Label>().First().Text;
                bool done = blocked ? text.Contains("再按") : text.Contains("更新完成，可以關閉此視窗");
                if (done) { final = text; timer.Stop(); window.Close(); }
                else if (DateTime.UtcNow > deadline) { timer.Stop(); throw new Exception("Updater window did not finish: " + text); }
            };
            timer.Start(); Application.Run(window);
            if (blocked) held.ReleaseMutex();
            Check(final != null, "No final updater message");
        }
    }
    [STAThread] private static void Main(string[] args)
    {
        CultureInfo.DefaultThreadCurrentUICulture = new CultureInfo("zh-HK");
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        reference = args[0]; suite = args[1]; Directory.CreateDirectory(suite);
        Test("complete update, original program backup, data/config retained, repeat update", delegate {
            string root = Fixture("success");
            string backup = FormDigitalUpdateEngine.Apply(root, delegate { });
            Check(File.ReadAllText(Path.Combine(backup, "previous-dist", "index.js")) == "old program", "No old program backup");
            foreach (var file in FormDigitalUpdateEngine.Manifest().files)
                Check(FormDigitalUpdateEngine.FileHash(FormDigitalUpdateEngine.SafePath(Path.Combine(root, "app", "dist"), file.Key)) == file.Value, "Installed file mismatch");
            Preserved(root); FormDigitalUpdateEngine.Apply(root, delegate { }); Preserved(root);
        });
        foreach (string point in new[] { "staged", "old-moved", "new-moved" })
        {
            string stage = point;
            Test("rollback after " + point, delegate {
                string root = Fixture("rollback-" + stage);
                MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }, delegate(string p) { if (p == stage) throw new IOException("Injected test failure"); }); });
                Check(File.ReadAllText(Path.Combine(root, "app", "dist", "index.js")) == "old program", "Rollback did not restore old program");
                Preserved(root);
            });
        }
        foreach (bool newPresent in new[] { false, true })
        {
            bool installed = newPresent;
            Test("interrupted update recovery: new directory " + newPresent, delegate {
                string root = Fixture("interrupted-" + installed);
                string pending = Path.Combine(root, ".formdigital-update-pending"); Directory.CreateDirectory(pending);
                File.WriteAllText(Path.Combine(pending, "transaction.txt"), "FormDigital update transaction v1");
                Directory.Move(Path.Combine(root, "app", "dist"), Path.Combine(pending, "previous-dist"));
                if (installed) { Directory.CreateDirectory(Path.Combine(root, "app", "dist")); File.WriteAllText(Path.Combine(root, "app", "dist", "index.js"), "interrupted new program"); }
                FormDigitalUpdateEngine.Apply(root, delegate { }); Preserved(root);
                Check(Directory.GetFiles(Path.Combine(root, ".formdigital-update-backups"), "index.js", SearchOption.AllDirectories).Any(p => File.ReadAllText(p) == "old program"), "Recovered old files lost");
            });
        }
        Test("incompatible version refused without replacement", delegate {
            string root = Fixture("incompatible"); File.AppendAllText(Path.Combine(root, "app", "package.json"), " ");
            MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }); });
            Check(File.ReadAllText(Path.Combine(root, "app", "dist", "index.js")) == "old program", "Wrong package replaced"); Preserved(root);
        });
        Test("exclusive update lock", delegate {
            string root = Fixture("locked");
            using (var held = new FileStream(Path.Combine(root, ".formdigital-update.lock"), FileMode.Create, FileAccess.ReadWrite, FileShare.None))
                MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }); });
            Preserved(root);
        });
        Test("unexpected data in the program directory is never moved", delegate {
            string root = Fixture("extra-data");
            File.WriteAllText(Path.Combine(root, "app", "dist", "customer-data.json"), "synthetic user data");
            MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }); });
            Check(File.ReadAllText(Path.Combine(root, "app", "dist", "customer-data.json")) == "synthetic user data", "Extra data moved");
        });
        Test("newer versions cannot be downgraded", delegate {
            string root = Fixture("newer-version");
            File.WriteAllText(Path.Combine(root, "app", "dist", "formdigital-release.json"), "{\"version\":\"2099.1.1.1\"}");
            MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }); }); Preserved(root);
        });
        Test("traversal and absolute paths rejected", delegate {
            MustFail(delegate { FormDigitalUpdateEngine.SafePath(suite, "../outside"); });
            MustFail(delegate { FormDigitalUpdateEngine.SafePath(suite, "C:\\outside"); });
            MustFail(delegate { FormDigitalUpdateEngine.SafePath(suite, "file:stream"); });
        });
        Test("unrecognized pending folder retained", delegate {
            string root = Fixture("unknown-pending"); Directory.CreateDirectory(Path.Combine(root, ".formdigital-update-pending"));
            MustFail(delegate { FormDigitalUpdateEngine.Apply(root, delegate { }); }); Preserved(root);
        });
        // Applies the SAME engine/payload to a separately prepared complete
        // package copy for the subsequent real no-login browser smoke test.
        if (args.Length > 2)
        {
            Test("complete isolated package update", delegate { FormDigitalUpdateEngine.Apply(args[2], delegate { }); });
            Test("running program refused", delegate {
                using (var child = Process.Start(new ProcessStartInfo(Path.Combine(args[2], "runtime", "node.exe"), "-e \"setInterval(()=>{},1000)\"") { UseShellExecute = false, CreateNoWindow = true }))
                {
                    try { MustFail(delegate { FormDigitalUpdateEngine.Apply(args[2], delegate { }); }); }
                    finally { child.Kill(); child.WaitForExit(10000); }
                }
            });
            Test("hidden real update window completes and can close", delegate { CheckWindow(args[2], false); });
            Test("hidden real window asks to save/close a running app", delegate { CheckWindow(Fixture("ui-busy"), true); });
        }
        Console.WriteLine(passed + " updater tests passed. Fixtures: " + suite);
    }
}
