; Adds <install folder>\resources\cli (eez-cli.cmd) to the user PATH.
; Raw registry value keeps %VAR% entries unexpanded, written back as REG_EXPAND_SZ.

!macro eezCliPath ADD
  nsExec::ExecToLog `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$p = (Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }); if (${ADD}) { $$parts += $$d }; New-ItemProperty -Path 'HKCU:\Environment' -Name Path -PropertyType ExpandString -Value ($$parts -join ';') -Force | Out-Null"`
  Pop $0
  ; HWND_BROADCAST, WM_SETTINGCHANGE: new terminals see the changed PATH
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customInstall
  !insertmacro eezCliPath "$$true"
!macroend

!macro customUnInstall
  !insertmacro eezCliPath "$$false"
!macroend
