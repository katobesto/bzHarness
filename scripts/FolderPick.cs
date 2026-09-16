using System;
using System.Runtime.InteropServices;

public class FolderPick
{
    [ComImport]
    [Guid("42F85136-DB7E-439C-85F2-E509235FCAA6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int QI(ref Guid riid, out IntPtr ppv);
        [PreserveSig] int AddRef();
        [PreserveSig] int Release();
        [PreserveSig] int ShowModal(IntPtr hwndOwner);
        [PreserveSig] int GetParent(out IntPtr phwnd);
        [PreserveSig] int SetParent(IntPtr hwnd);
        [PreserveSig] int DisableWindow(bool fDisable);
        [PreserveSig] int EnableWindow(bool fEnable);
        [PreserveSig] int Show(IntPtr hwndOwner);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFileTypes);
        [PreserveSig] int GetFileTypes(out uint pcFileTypes, out IntPtr ppFileTypes);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Pivot(IShellItem psi);
        [PreserveSig] int SetFolder(IShellItem psi);
        [PreserveSig] int GetFolder(out IShellItem ppsi);
        [PreserveSig] int GetExtraTile(out IShellItem ppsi);
        [PreserveSig] int SetDefaultFolder(IShellItem psi);
        [PreserveSig] int GetDefaultFolder(out IShellItem ppsi);
        [PreserveSig] int SetFileName(string pszName);
        [PreserveSig] int GetFileName(out string pszName);
        [PreserveSig] int Cancel();
        [PreserveSig] int SetOptions(int fldOptions);
        [PreserveSig] int GetOptions(out int pfldOptions);
        [PreserveSig] int GetResult(out IntPtr ppsi);
        [PreserveSig] int SetClientGuid(ref Guid pguid);
        [PreserveSig] int ApplyClientSettings();
        [PreserveSig] int ResetClientSettings();
        [PreserveSig] int GetResults(out IntPtr pva);
        [PreserveSig] int GetSelectedItems(out IntPtr pva);
    }

    [ComImport]
    [Guid("2E94F49A-9046-4D43-9CB1-594FAC5ABAA9")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int QI(ref Guid riid, out IntPtr ppv);
        [PreserveSig] int AddRef();
        [PreserveSig] int Release();
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid rbid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sdn, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgao);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, out IntPtr ppv);

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, int dwClsContext, ref Guid riid, out IntPtr ppv);

    private static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4D7A-8F80-A49DAEFFDCCF");
    private static readonly Guid IID_IFileOpenDialog = new Guid("D57C7288-D405-43D8-9D2B-3FBF09CF0F6A");
    private static readonly Guid IID_IShellItem = new Guid("2E94F49A-9046-4D43-9CB1-594FAC5ABAA9");

    public static string Pick(string initialPath)
    {
        Guid clsid = CLSID_FileOpenDialog;
        Guid iidDlg = IID_IFileOpenDialog;
        Guid iidItem = IID_IShellItem;
        IntPtr pUnk = IntPtr.Zero;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iidDlg, out pUnk);
        if (hr != 0 || pUnk == IntPtr.Zero) return null;
        IFileOpenDialog dlg = (IFileOpenDialog)Marshal.GetObjectForIUnknown(pUnk);
        try
        {
            dlg.SetOptions(0x20);
            if (!string.IsNullOrEmpty(initialPath))
            {
                IntPtr pItem = IntPtr.Zero;
                int hr2 = SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iidItem, out pItem);
                if (hr2 == 0 && pItem != IntPtr.Zero)
                {
                    IShellItem si = (IShellItem)Marshal.GetObjectForIUnknown(pItem);
                    try
                    {
                        dlg.SetFolder(si);
                    }
                    finally
                    {
                        si.Release();
                    }
                }
            }
            hr = dlg.Show(IntPtr.Zero);
            if (hr != 0) return null;
            IntPtr pSel = IntPtr.Zero;
            dlg.GetResult(out pSel);
            if (pSel == IntPtr.Zero) return null;
            IShellItem sel = (IShellItem)Marshal.GetObjectForIUnknown(pSel);
            try
            {
                IntPtr pName = IntPtr.Zero;
                sel.GetDisplayName(0, out pName);
                if (pName == IntPtr.Zero) return null;
                return Marshal.PtrToStringUni(pName);
            }
            finally
            {
                sel.Release();
            }
        }
        finally
        {
            Marshal.ReleaseComObject(dlg);
        }
    }
}