$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Fondo redondeado oscuro
$bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#141926"))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($bg, $path)

# Borde acento
$border = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#6C8CFF")), 5
$g.DrawPath($border, $path)

# Punto acento (spark) sobre las siglas
$dot = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#6C8CFF"))
$g.FillEllipse($dot, ($size / 2) - 13, 46, 26, 26)

# Siglas BZH
$font = New-Object System.Drawing.Font("Segoe UI", 82, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#E9ECF1"))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, 56, $size, ($size - 56)
$g.DrawString("BZH", $font, $brush, $rect, $sf)
$g.Dispose()

$out = Join-Path $root "assets"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$png = Join-Path $out "icon.png"
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# .ico = contenedor ICO con el PNG embebido (Vista+)
$pngBytes = [IO.File]::ReadAllBytes($png)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]1)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([uint16]1)
$bw.Write([uint16]32)
$bw.Write([uint32]$pngBytes.Length)
$bw.Write([uint32]22)
$bw.Write($pngBytes)
$bw.Flush()
[IO.File]::WriteAllBytes((Join-Path $out "icon.ico"), $ms.ToArray())
Write-Output ("icon.png y icon.ico generados en " + $out)