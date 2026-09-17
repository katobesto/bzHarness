const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;
  let serverHandle = null;

  function iconPath() {
    return app.isPackaged
      ? path.join(process.resourcesPath, "assets", "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.ico");
  }

  function createWindow(url) {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 940,
      minHeight: 560,
      show: false,
      backgroundColor: "#0a0c10",
      icon: iconPath(),
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) shell.openExternal(target);
      return { action: "deny" };
    });
    win.once("ready-to-show", () => win.show());
    win.loadURL(url);
    win.on("closed", () => (win = null));
  }

  async function start() {
    process.env.HARNESS_HOME = app.getPath("userData");
    process.env.HARNESS_SCRIPTS = app.isPackaged ? path.join(process.resourcesPath, "scripts") : path.join(__dirname, "..", "scripts");
    const { startServer } = await import(pathToFileURL(path.join(__dirname, "..", "src", "server.js")).href);
    serverHandle = await startServer({ port: 0 });
    createWindow(serverHandle.url);
  }

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("window-all-closed", () => {
    if (serverHandle) {
      try {
        serverHandle.server.close(() => app.quit());
      } catch {
        app.quit();
      }
      setTimeout(() => app.quit(), 2000).unref();
    } else {
      app.quit();
    }
  });

  app.whenReady()
    .then(() => app.setAppUserModelId("com.benjo.bzHarness"))
    .then(start)
    .catch((e) => {
      console.error("bzHarness (electron) fallo al arrancar:", e);
      app.quit();
    });
}