param(
    [ValidateRange(1, 65535)]
    [int] $Port = 3000,
    [string] $EnvFile = (Join-Path $PSScriptRoot '../.env'),
    [string[]] $AllowedEmail
)

$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
    throw "Cloudflare Tunnel was not found at $cloudflared."
}
$qr = Get-Command qrcode-terminal.cmd -ErrorAction Stop
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$setup = Join-Path $PSScriptRoot 'mobile-tunnel-config.js'

if (-not $AllowedEmail) {
    $AllowedEmail = Read-Host 'Approved tester email addresses (comma-separated)'
}
$testerEmails = @(($AllowedEmail -join ',') -split ',' | ForEach-Object { $_.Trim() })
foreach ($email in $testerEmails) {
    if ($email -notmatch '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z0-9]{2,}$') {
        throw 'Use exact tester email addresses. Blank addresses and domain wildcards are unsupported.'
    }
}

$legacyConnector = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -match "http://(?:127\.0\.0\.1|localhost):${Port}(?:[/\s`"]|$)" -and
        $_.CommandLine -notmatch '(?:^|\s)--allowed-mail(?:\s|=)' }
if ($legacyConnector) { throw "Close the existing Quick Tunnel for port $Port before starting the email-protected tunnel." }

& $node.Source $setup $EnvFile $Port $qr.Source
if ($LASTEXITCODE -ne 0) { throw 'Mobile tunnel preflight failed.' }

$origin = "http://127.0.0.1:$Port"
$lastTunnelHost = $null
$originalEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & $cloudflared tunnel --url $origin --protocol http2 --no-autoupdate --allowed-mail ($testerEmails -join ',') 2>&1 |
        ForEach-Object {
            $line = $_.ToString()
            if ($line -match '\|\s+https://(?<hostname>[a-z0-9-]+\.trycloudflare\.com)\s+\|') {
                $tunnelHost = $Matches['hostname']
                if ($tunnelHost -ne $lastTunnelHost) {
                    & $node.Source $setup $EnvFile $Port $qr.Source $tunnelHost
                    if ($LASTEXITCODE -ne 0) { throw 'Could not verify Cloudflare email protection for the new link.' }
                    $lastTunnelHost = $tunnelHost

                    Write-Host 'Share this URL with approved testers and keep this terminal open.'
                    Write-Host 'Testers enter their approved email and its one-time PIN on the Cloudflare page, then use the normal NeighborLens login.'
                }
            } else {
                Write-Host $line
            }
        }
} finally {
    [Console]::OutputEncoding = $originalEncoding
}

if (-not $lastTunnelHost) { throw 'Cloudflare exited before assigning a Quick Tunnel hostname.' }
