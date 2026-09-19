// Regenerate the committed Finder backgrounds on macOS:
//   cd desktop && swift make-dmg-background.swift
// The 1x and 2x images are combined into a Retina TIFF by electron-builder.
// The app and Applications icons are real Finder items, not painted replicas.
import AppKit
import CoreText

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
try FileManager.default.createDirectory(at: directory.appendingPathComponent("build"), withIntermediateDirectories: true)
let fontURL = directory.appendingPathComponent("fonts/space-grotesk-variable.woff2")
var registrationError: Unmanaged<CFError>?
guard CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, &registrationError),
      let titleFont = NSFont(name: "SpaceGrotesk-Light_Medium", size: 26),
      let bodyFont = NSFont(name: "SpaceGrotesk-Light_Regular", size: 16) else {
    fatalError("The bundled Space Grotesk font could not be loaded")
}

let width: CGFloat = 660
let height: CGFloat = 440
let paper = NSColor(srgbRed: 234 / 255, green: 231 / 255, blue: 226 / 255, alpha: 1)
let ink = NSColor(srgbRed: 44 / 255, green: 47 / 255, blue: 68 / 255, alpha: 1)
let muted = NSColor(srgbRed: 95 / 255, green: 98 / 255, blue: 116 / 255, alpha: 1)

for scale in [1, 2] {
    let pixelsWide = Int(width) * scale
    let pixelsHigh = Int(height) * scale
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
        pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: pixelsWide * 4, bitsPerPixel: 32),
        let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fatalError("Could not create the installer background")
    }
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    graphics.cgContext.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    paper.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()

    func label(_ value: String, font: NSFont, color: NSColor, center: CGFloat, top: CGFloat) {
        let string = NSAttributedString(string: value, attributes: [.font: font, .foregroundColor: color])
        let size = string.size()
        string.draw(at: NSPoint(x: center - size.width / 2, y: height - top - size.height))
    }
    // A compact Masora mark and name. No installer wizard or extra choices.
    let title = NSAttributedString(string: "Zevet", attributes: [.font: titleFont])
    let groupWidth = 24 + 12 + title.size().width
    let left = (width - groupWidth) / 2
    ink.setFill()
    for (x, y) in [(12.0, 4.0), (4.0, 18.0), (20.0, 18.0)] {
        NSBezierPath(ovalIn: NSRect(x: left + x - 3, y: height - 69 - y - 3, width: 6, height: 6)).fill()
    }
    label("Zevet", font: titleFont, color: ink, center: left + 36 + title.size().width / 2, top: 62)

    // The only directional cue points between the two real drag targets.
    muted.setStroke()
    let arrow = NSBezierPath()
    arrow.lineWidth = 2
    arrow.lineCapStyle = .round
    arrow.lineJoinStyle = .round
    arrow.move(to: NSPoint(x: 303, y: height - 232))
    arrow.line(to: NSPoint(x: 357, y: height - 232))
    arrow.move(to: NSPoint(x: 348, y: height - 223))
    arrow.line(to: NSPoint(x: 357, y: height - 232))
    arrow.line(to: NSPoint(x: 348, y: height - 241))
    arrow.stroke()
    label("Drag Zevet to Applications.", font: bodyFont, color: muted, center: width / 2, top: 347)

    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fatalError("Could not encode the installer background")
    }
    let suffix = scale == 1 ? "" : "@2x"
    let output = directory.appendingPathComponent("build/dmg-background\(suffix).png")
    try png.write(to: output)
    print("Wrote \(output.lastPathComponent): \(pixelsWide) × \(pixelsHigh)")
}
