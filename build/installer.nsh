; Uninstalling removes the start-at-login entry the app may have added (Electron names it after
; the AppUserModelId). Your data folder and settings are left alone.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.manraj.tartan"
!macroend
