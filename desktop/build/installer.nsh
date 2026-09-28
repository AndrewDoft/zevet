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
; through MUI2's page framework. ${FileExists} below is a LogicLib macro
; that expands to the native IfFileExists instruction, not a Call, so it
; cannot exhibit whatever that was.
;
; A second incident (Andrew's own machine, observed 2026-09-27) went past
; what a suffix-only sanitizer (this macro's first version) guards: the
; registry's InstallLocation ended up completely EMPTY at DisplayVersion
; 0.2.74 -- not merely missing its \${APP_FILENAME} suffix -- while the
; REAL app on disk, at the standard per-user default, was still sitting
; there untouched at the unsigned 0.2.71 build the whole time.
;
; A suffix check cannot catch this class of bug at all: appending
; \${APP_FILENAME} onto a wrong-but-suffix-less root (the original
; "C:\Program", truncated exactly at a space somewhere upstream) produces a
; NEW wrong-but-correctly-suffixed path ("C:\Program\zevet") -- internally
; consistent, and still nowhere the real app lives. installApplicationFiles
; runs before registryAddInstallInfo (installSection.nsh), and NSIS does
; not abort a section when a File/SetOutPath call into a bad path silently
; extracts nothing -- it logs and keeps going -- so registryAddInstallInfo
; still records the new DisplayVersion and InstallLocation as if the update
; had worked, and the NEXT update reads that (still wrong) value back and
; repeats, compounding across releases with no error ever surfaced.
;
; The registry is a CACHE of where the app was last installed, and a cache
; can go stale. The ground truth is simpler and cannot lie the same way:
; does ${APP_EXECUTABLE_FILENAME} actually exist at $INSTDIR? If yes, this
; is a real install (default or a deliberately customised one) and nothing
; changes. If no, prefer the real orphaned install at this mode's standard
; location over trusting whatever the registry says -- so a corrupted
; pointer can never make a working install look like there is nothing to
; update. Runs before any UI page (customInit is in .onInit), so an
; interactive install can still steer $INSTDIR elsewhere afterwards; this
; only ever changes what a SILENT install treats as final, or what an
; interactive one starts the directory page showing.

; ZEVET_CUSTOMINIT_LOG: plain FileWrite (no plugin) appending every decision
; this macro makes to %TEMP%\zevet-install-debug.log, so a silent /S run that
; extracts nothing still leaves a trail of what $INSTDIR and $installMode
; actually were. ponytail: delete once the fresh-/S CI gates below have been
; green for a few releases and nobody has needed to read this file.
!macro customInit
  FileOpen $R9 "$TEMP\zevet-install-debug.log" a
  FileWrite $R9 "customInit: installMode=$installMode INSTDIR(before)=$INSTDIR$\r$\n"
  FileClose $R9
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${If} $installMode == "all"
      StrCpy $3 "$PROGRAMFILES64\${APP_FILENAME}"
    ${Else}
      ; ponytail: multiUser.nsh's own SHGetKnownFolderPath dance covers a
      ; Win7 corner this plain default never needs; upgrade if that corner
      ; ever turns out to matter.
      StrCpy $3 "$LocalAppData\Programs\${APP_FILENAME}"
    ${EndIf}
    StrCpy $INSTDIR "$3"
  ${EndIf}
  FileOpen $R9 "$TEMP\zevet-install-debug.log" a
  FileWrite $R9 "customInit: INSTDIR(after)=$INSTDIR$\r$\n"
  FileClose $R9
!macroend
