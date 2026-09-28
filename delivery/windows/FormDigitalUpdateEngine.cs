using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

internal sealed class UpdateManifest
{
    public string version { get; set; }
    public string payloadSha256 { get; set; }
    public Dictionary<string, string> files { get; set; }
    public Dictionary<string, string> baseFiles { get; set; }
    public string[] baseDistFiles { get; set; }
}

internal static class FormDigitalUpdateEngine
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string Hash(Stream input)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }
    internal static string FileHash(string file) { using (var input = File.OpenRead(file)) return Hash(input); }
    internal static UpdateManifest Manifest()
    {
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("update-manifest.json"))
        using (var reader = new StreamReader(input)) return Json.Deserialize<UpdateManifest>(reader.ReadToEnd());
    }
    internal static string SafePath(string root, string relative)
    {
        if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.Contains(":")) throw new IOException("Unsafe update path.");
        root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("Unsafe update path.");
        NoLinks(full);
        return full;
    }
    internal static void NoLinks(string path)
    {
        for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Linked folders are not supported by this updater.");
    }
    internal static void VerifyBase(string root, UpdateManifest manifest)
    {
        NoLinks(root);
        if (!File.Exists(SafePath(root, "Form Digital.exe")) || !File.Exists(SafePath(root, "runtime/node.exe"))) throw new IOException("Choose the folder containing Form Digital.exe, app and runtime.");
        foreach (var file in manifest.baseFiles)
        {
            string target = SafePath(root, file.Key);
            if (!File.Exists(target) || FileHash(target) != file.Value) throw new IOException("This package version is not compatible with this update. No program files were replaced.");
        }
    }
    internal static void EnsureStopped(string root)
    {
        string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (Process process in Process.GetProcesses()) using (process)
        {
            if (process.Id == Process.GetCurrentProcess().Id) continue;
            string executable;
            try { executable = process.MainModule.FileName; }
            catch { continue; }
            if (executable.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Save your work and close Form Digital before updating, then retry.");
        }
    }
    private static void VerifyProgramDirectory(string dist, UpdateManifest manifest)
    {
        var allowed = new HashSet<string>(manifest.files.Keys, StringComparer.OrdinalIgnoreCase);
        foreach (string name in manifest.baseDistFiles) allowed.Add(name);
        var folders = new Stack<string>(); folders.Push(dist);
        while (folders.Count > 0)
        {
            string folder = folders.Pop(); NoLinks(folder);
            foreach (string file in Directory.GetFiles(folder))
            {
                NoLinks(file);
                string relative = file.Substring(dist.Length + 1).Replace('\\', '/');
                if (!allowed.Contains(relative)) throw new IOException("The program directory contains additional files. Nothing was replaced. Contact the maintainer to keep these files safe.");
            }
            foreach (string child in Directory.GetDirectories(folder)) { NoLinks(child); folders.Push(child); }
        }
        string release = Path.Combine(dist, "formdigital-release.json");
        if (File.Exists(release))
        {
            var current = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(release));
            Version installed, incoming;
            if (!current.ContainsKey("version") || !Version.TryParse(Convert.ToString(current["version"]), out installed) || !Version.TryParse(manifest.version, out incoming))
                throw new IOException("The installed version could not be verified.");
            if (installed > incoming) throw new IOException("A newer version is already installed. This updater will not downgrade it.");
        }
    }
    private static string Archive(string root, string pending)
    {
        string backups = SafePath(root, ".formdigital-update-backups");
        Directory.CreateDirectory(backups);
        string saved = SafePath(backups, DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N"));
        Directory.Move(pending, saved);
        return saved;
    }
    // Runs before a new attempt. A stopped process between either directory
    // rename is recovered from the retained old directory, not from memory.
    private static void Recover(string root, string pending)
    {
        if (!Directory.Exists(pending)) return;
        string marker = SafePath(pending, "transaction.txt");
        if (!File.Exists(marker) || File.ReadAllText(marker) != "FormDigital update transaction v1")
            throw new IOException("An unrecognized pending-update folder exists. Contact the maintainer.");
        string backup = SafePath(pending, "previous-dist");
        string dist = SafePath(root, "app/dist");
        if (Directory.Exists(backup))
        {
            if (Directory.Exists(dist)) Directory.Move(dist, SafePath(pending, "recovered-new-dist-" + Guid.NewGuid().ToString("N")));
            Directory.Move(backup, dist);
        }
        if (!Directory.Exists(dist)) throw new IOException("Previous program files could not be recovered. Keep this folder and contact the maintainer.");
        Archive(root, pending);
    }
    internal static string Apply(string root, Action<string> progress, Action<string> checkpoint = null)
    {
        root = Path.GetFullPath(root);
        var manifest = Manifest();
        VerifyBase(root, manifest);
        EnsureStopped(root);
        string pending = SafePath(root, ".formdigital-update-pending");
        // A per-package file lock also protects command-line/maintenance users.
        string lockPath = SafePath(root, ".formdigital-update.lock");
        using (var updateLock = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
        {
            Recover(root, pending);
            VerifyProgramDirectory(SafePath(root, "app/dist"), manifest);
            Directory.CreateDirectory(pending);
            File.WriteAllText(SafePath(pending, "transaction.txt"), "FormDigital update transaction v1");
            try
            {
                progress("checking");
                string staged = SafePath(pending, "next-dist");
                Directory.CreateDirectory(staged);
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                {
                    if (Hash(payload) != manifest.payloadSha256) throw new IOException("The update file is damaged. Download it again.");
                    payload.Position = 0;
                    using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                    {
                        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var entry in zip.Entries)
                        {
                            string name = entry.FullName;
                            if (!manifest.files.ContainsKey(name) || !seen.Add(name)) throw new IOException("Unexpected update content.");
                            string target = SafePath(staged, name);
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            using (var input = entry.Open()) using (var output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
                            if (FileHash(target) != manifest.files[name]) throw new IOException("Update verification failed.");
                        }
                        if (seen.Count != manifest.files.Count) throw new IOException("Incomplete update content.");
                    }
                }
                if (checkpoint != null) checkpoint("staged");
                EnsureStopped(root);
                progress("installing");
                string dist = SafePath(root, "app/dist");
                string old = SafePath(pending, "previous-dist");
                Directory.Move(dist, old);
                if (checkpoint != null) checkpoint("old-moved");
                Directory.Move(staged, dist);
                if (checkpoint != null) checkpoint("new-moved");
                foreach (var item in manifest.files)
                    if (FileHash(SafePath(dist, item.Key)) != item.Value) throw new IOException("Installed files failed verification.");
                File.WriteAllText(SafePath(pending, "installed-version.txt"), manifest.version);
                string backupFolder = Archive(root, pending);
                progress("complete");
                return backupFolder;
            }
            catch
            {
                // If restoration itself fails, keep the pending journal and
                // backup in place. The next run tries recovery before staging.
                Recover(root, pending);
                throw;
            }
        }
    }
}
