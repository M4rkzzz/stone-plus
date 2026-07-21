; StonePlus installer lifecycle additions.
; User data is deliberately preserved during uninstall so accounts, logs and backups
; are not removed without an explicit in-app action.

!macro customInstall
  ; Stone+ v0.8.3 and earlier used the old "Stone" product identity while sharing
  ; the same default install directory. Remove only stale legacy integration when
  ; neither of the standard legacy executables still exists.
  IfFileExists "$LOCALAPPDATA\Programs\stone-desktop\Stone.exe" stoneLegacyCleanupDone
  IfFileExists "$PROGRAMFILES64\stone-desktop\Stone.exe" stoneLegacyCleanupDone

  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Stone.lnk"
  Delete "$DESKTOP\Stone.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Stone"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "stone-desktop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\32fbec86-8af3-5ce0-ad1a-5734d1c8553e"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\32fbec86-8af3-5ce0-ad1a-5734d1c8553e"

stoneLegacyCleanupDone:
  ; v0.9.x used the Stone+ display name. Remove its stale shortcuts and login item
  ; while retaining the same installation directory and application data.
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Stone+.lnk"
  Delete "$DESKTOP\Stone+.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Stone+"
!macroend

!macro customUnInstall
  ; Electron's login-item setting is a user Run entry and must not survive uninstall.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "StonePlus"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Stone+"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "stone-desktop"
!macroend
