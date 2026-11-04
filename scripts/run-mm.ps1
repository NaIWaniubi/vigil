$ErrorActionPreference = 'Stop'
Set-Location 'E:\myzcode\vigil'
$envExports = & node scripts/load-channels.mjs 2>$null
foreach ($line in $envExports) {
  if ($line -match "^export (\w+)='(.*)'$") {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
Get-Content /tmp/local-keys.sh | ForEach-Object {
  if ($_ -match '^export (\w+)=(.*)$') {
    $v = $matches[2].Trim('"')
    [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process')
  }
}
& node scripts/cluster.mjs --models deepseek:deepseek-chat,opencsg-local:qwen3.8-max,orcaterm-local:glm-5.3,agent2api-local:gemini-3-flash-preview --family rush --reps 2 --concurrency 6 --pace-ms 500 --cap opencsg-local=2 --cap orcaterm-local=2 --cap agent2api-local=2 --budget-usd 20 --limit 30 --out runs/rush-mm --resume *>&1 | Tee-Object -FilePath 'E:\myzcode\vigil\runs\mm-console.log'
