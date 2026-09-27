; electron-builder's default NSIS hook: build/installer.nsh is picked up
; automatically (nsis.include is unset, and getResource falls back to a file
; of this name in buildResourcesDir) and customInit runs at the end of
; .onInit, right after initMultiUser sets $INSTDIR -- for EVERY install,
; silent or interactive, fresh or update. See app-update.js and this
; repo's incident notes for the reason this exists:
;
; A per-machine zevet install was found with
;   HKLM\Software\<guid>\InstallLocation = "C:\Program"
; instead of "C:\Program Files\zevet" -- truncated exactly at the space, and
; the value multiUser.nsh's setInstallModePerAllUsers/setInstallModePerUser
; both read straight out of the registry and reuse verbatim as $INSTDIR for
; every later update (see their ReadRegStr ... InstallLocation +
; StrCpy $INSTDIR $perMachineInstallationFolder). Once that value is wrong,
; every future silent update keeps extracting the new build into the wrong
; place while the real app folder is emptied by the old-version uninstall
; step, and the app is left uninstalled with no dialog and exit code 0.
;
; assistedInstaller.nsh already has a sanitizer for exactly this shape
; (instFilesPre, appending \${APP_FILENAME} when $INSTDIR does not already
; end in it) -- but it is the PRE function of the interactive directory page,
; which a silent /S install never shows. This is the same check, moved
; somewhere that actually runs every time.
;
; It does not recover the ORIGINAL correct path -- there is no way to, once
; the registry only has the truncated one -- but it guarantees $INSTDIR is
; always the app's own dedicated folder, never a shared root files can be
; extracted into or deleted from underneath something else.
;
; NOT ${StrContains} (the plugin-free StrContains.nsh function assistedInstaller.nsh
; uses): calling it from customInit crashed the installer outright
; (0xC0000005) on GitHub Actions windows-latest, reproduced twice and
; isolated to this macro by removing it and watching the crash disappear.
; The exact interaction was not chased further -- root-caused instead to
; something in Call/Push/Pop from inside .onInit at this exact point, which
; instFilesPre never hits because it runs later, as its own Function called
; through MUI2's page framework. This does the same check with only native
; StrLen/StrCpy/IntOp, no Call to a shared Function and nothing on the
; stack, which cannot exhibit whatever that was.

!macro customInit
  StrLen $0 "\${APP_FILENAME}"
  IntOp $1 $0 * -1
  StrCpy $2 "$INSTDIR" $0 $1
  ${If} $2 != "\${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
!macroend
