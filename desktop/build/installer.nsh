; electron-builder's default NSIS hook: `build/installer.nsh` is picked up
; automatically (nsis.include is unset, and getResource falls back to a file
; of this name in buildResourcesDir) and `customInit` runs at the end of
; .onInit, right after `initMultiUser` sets $INSTDIR — for EVERY install,
; silent or interactive, fresh or update. See app-update.js and
; docs/contracts/ for the incident this guards against:
;
; A per-machine zevet install was found with
;   HKLM\Software\<guid>\InstallLocation = "C:\Program"
; instead of "C:\Program Files\zevet" — truncated exactly at the space, and
; the value multiUser.nsh's setInstallModePerAllUsers/setInstallModePerUser
; both read straight out of the registry and reuse verbatim as $INSTDIR for
; every later update (see their `ReadRegStr ... InstallLocation` +
; `StrCpy $INSTDIR $perMachineInstallationFolder`). Once that value is wrong,
; every future silent update keeps extracting the new build into the wrong
; place while the real app folder is emptied by the old-version uninstall
; step, and the app is left uninstalled with no dialog and exit code 0.
;
; assistedInstaller.nsh already has a sanitizer for exactly this shape
; (`instFilesPre`, appending \${APP_FILENAME} when $INSTDIR does not already
; end in it) — but it is the PRE function of the interactive directory page,
; which a silent `/S` install never shows. This is the same check, moved
; somewhere that actually runs every time.
;
; It does not recover the ORIGINAL correct path — there is no way to, once
; the registry only has the truncated one — but it guarantees $INSTDIR is
; always the app's own dedicated folder, never a shared root files can be
; extracted into or deleted from underneath something else.
;
; ⚠️ NOT `!include StrContains.nsh` HERE: assistedInstaller.nsh already does
; that (guarded by `allowToChangeInstallationDirectory`, which is set in
; desktop/package.json), and that file has no include-guard of its own — a
; second `!include` redefines its Function/Vars and fails the build. Its
; include happens earlier in the assembled script than this macro is ever
; invoked (installer.nsi includes assistedInstaller.nsh before it calls
; customInit in .onInit), so ${StrContains} is already available here.

!macro customInit
  ${StrContains} $0 "${APP_FILENAME}" "$INSTDIR"
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend
