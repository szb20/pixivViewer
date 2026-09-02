param(
  [string]$Expression,

  [string]$ExpressionFile,

  [string]$WsUrl = 'ws://127.0.0.1:9222/devtools/page/DA80CA21AE69EFE707E3DA4F153B31EB',

  [int]$TimeoutSec = 60
)

# CDP helper: evaluate a JS expression in the connected WebView page.
# Usage: powershell -File scripts/cdp-eval.ps1 -Expression "(async()=>{ ... })()"

$ErrorActionPreference = 'Stop'

if (-not $Expression) {
  if (-not $ExpressionFile -or -not (Test-Path $ExpressionFile)) {
    throw 'Provide -Expression or a valid -ExpressionFile'
  }
  $Expression = Get-Content -Raw -LiteralPath $ExpressionFile
}

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]::new($WsUrl), $ct).GetAwaiter().GetResult()

$msg = @{
  id     = 1
  method = 'Runtime.evaluate'
  params = @{
    expression      = $Expression
    awaitPromise    = $true
    returnByValue   = $true
    userGesture     = $true
  }
} | ConvertTo-Json -Depth 8 -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
$ws.SendAsync([ArraySegment[byte]]::new($bytes),
  [System.Net.WebSockets.WebSocketMessageType]::Text,
  $true,
  $ct).GetAwaiter().GetResult()

$buf = New-Object byte[] 262144
$ms = New-Object System.IO.MemoryStream
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
do {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'CDP timeout waiting for response' }
  $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $ct).GetAwaiter().GetResult()
  if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
  $ms.Write($buf, 0, $r.Count)
} while (-not $r.EndOfMessage)

$text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
$resp = $text | ConvertFrom-Json

if ($null -ne $resp.result) {
  if ($null -ne $resp.result.exceptionDetails) {
    Write-Output "JS_EXCEPTION: $($resp.result.exceptionDetails.text)"
    Write-Output ($resp.result.exceptionDetails | ConvertTo-Json -Depth 8)
  }
  if ($resp.result.result.value -is [string]) {
    Write-Output $resp.result.result.value
  } else {
    Write-Output ($resp.result.result | ConvertTo-Json -Depth 12 -Compress)
  }
} else {
  Write-Output ($resp | ConvertTo-Json -Depth 8 -Compress)
}

$ws.Dispose()
