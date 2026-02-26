const { app, BrowserWindow } = require("electron");
const path = require("path");
const serve = require("electron-serve");

const loadURL = serve({ directory: path.join(__dirname, "../expo/dist") });

function createWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: "MedusaPOS",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  loadURL(win);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
