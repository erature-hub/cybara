$ErrorActionPreference = "Stop"
Invoke-RestMethod -Uri "https://raw.githubusercontent.com/erature-hub/cybara/main/site/public/install.ps1" | Invoke-Expression
