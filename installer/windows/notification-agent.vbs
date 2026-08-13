Option Explicit

Dim shell, fso, localDataDir, pidPath, installDir, command, processId, exitCode, firstArgument
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
localDataDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Ozon GMV Dashboard"
pidPath = localDataDir & "\notifier.pid"
installDir = fso.GetParentFolderName(WScript.ScriptFullName)
firstArgument = ""
If WScript.Arguments.Count > 0 Then
  firstArgument = LCase(WScript.Arguments(0))
End If

If firstArgument = "/open" Then
  shell.Run "http://127.0.0.1:3001", 1, False
  WScript.Quit 0
End If

If firstArgument = "/stop" Then
  If fso.FileExists(pidPath) Then
    Dim pidFile, processes, process
    Set pidFile = fso.OpenTextFile(pidPath, 1)
    processId = Trim(pidFile.ReadAll)
    pidFile.Close
    Set processes = GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" & processId)
    For Each process In processes
      If InStr(LCase(process.CommandLine), "notification-agent.js") > 0 Then process.Terminate
    Next
    On Error Resume Next
    fso.DeleteFile pidPath, True
    On Error GoTo 0
  End If
  WScript.Quit 0
End If

If Not fso.FolderExists(localDataDir) Then fso.CreateFolder localDataDir
shell.Environment("PROCESS")("NOTIFIER_DATA_DIR") = localDataDir
command = Chr(34) & installDir & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & installDir & "\app\dist\server\notification-agent.js" & Chr(34)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
