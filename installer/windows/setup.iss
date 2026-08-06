#define AppName "Ozon GMV Dashboard"
#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif

[Setup]
AppId={{7B7D53F2-D6E6-44D0-A4EB-477AA9DAF8C5}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Ozon GMV Dashboard
DefaultDirName={autopf}\Ozon GMV Dashboard
DefaultGroupName=Ozon GMV Dashboard
OutputDir=output
OutputBaseFilename=OzonGMV-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName=Ozon GMV Dashboard
CloseApplications=no
RestartApplications=no

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "stage\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "stage\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "stage\OzonGMVService.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "OzonGMVService.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-service.ps1"; Flags: dontcopy
Source: "install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\Ozon GMV Dashboard"
Name: "{commonappdata}\Ozon GMV Dashboard\data"
Name: "{commonappdata}\Ozon GMV Dashboard\config"
Name: "{commonappdata}\Ozon GMV Dashboard\logs"
Name: "{commonappdata}\Ozon GMV Dashboard\backups"
Name: "{commonappdata}\Ozon GMV Dashboard\updates"

[Icons]
Name: "{autoprograms}\Ozon GMV Dashboard"; Filename: "http://127.0.0.1:3001"
Name: "{autodesktop}\Ozon GMV Dashboard"; Filename: "http://127.0.0.1:3001"

[Run]
Filename: "http://127.0.0.1:3001/setup"; Description: "打开 Ozon GMV Dashboard"; Flags: shellexec postinstall skipifsilent nowait

[Code]
var
  DeleteDataOnUninstall: Boolean;

function RunServiceScript(const Phase: String; const DeleteData: Boolean): Boolean;
var
  ResultCode: Integer;
  Params: String;
begin
  ExtractTemporaryFile('install-service.ps1');
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install-service.ps1') +
    '" -Phase ' + Phase + ' -InstallDir "' + ExpandConstant('{app}') +
    '" -DataDir "' + ExpandConstant('{commonappdata}\Ozon GMV Dashboard') + '"';
  if DeleteData then
    Params := Params + ' -DeleteData';
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not RunServiceScript('prepare', False) then
    Result := '无法停止旧服务或创建升级备份，安装已取消。'
  else
    Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if not RunServiceScript('install', False) then
      RaiseException('新版本健康检查失败，已尝试恢复旧版本。');
end;

function InitializeUninstall(): Boolean;
begin
  DeleteDataOnUninstall := MsgBox(
    '是否同时删除全部店铺、订单、配置和备份数据？' + #13#10 + #13#10 +
    '选择“否”将保留数据，今后重新安装可以继续使用。',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurUninstallStep = usUninstall then begin
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install-service.ps1') +
      '" -Phase uninstall -InstallDir "' + ExpandConstant('{app}') +
      '" -DataDir "' + ExpandConstant('{commonappdata}\Ozon GMV Dashboard') + '"';
    if DeleteDataOnUninstall then
      Params := Params + ' -DeleteData';
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
