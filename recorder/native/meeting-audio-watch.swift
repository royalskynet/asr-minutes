import AppKit
import CoreAudio
import Darwin
import Foundation

// 要偵測的會議 App bundle id（例 us.zoom.xos、com.microsoft.teams2），由環境變數 MEETING_APP_BUNDLE_ID 指定
private let targetBundleID: String = {
    guard let id = ProcessInfo.processInfo.environment["MEETING_APP_BUNDLE_ID"], !id.isEmpty else {
        FileHandle.standardError.write("未設定 MEETING_APP_BUNDLE_ID\n".data(using: .utf8)!)
        exit(2)
    }
    return id
}()

private func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func readValue<T>(_ objectID: AudioObjectID, selector: AudioObjectPropertySelector, initial: T) -> T? {
    var property = address(selector)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(objectID, &property, 0, nil, &size, pointer)
    }
    return status == noErr ? value : nil
}

private func audioProcessIDs() -> [AudioObjectID]? {
    var property = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    let systemObject = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(systemObject, &property, 0, nil, &size) == noErr else { return nil }
    var ids = [AudioObjectID](repeating: kAudioObjectUnknown, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    let status = ids.withUnsafeMutableBytes { bytes in
        AudioObjectGetPropertyData(systemObject, &property, 0, nil, &size, bytes.baseAddress!)
    }
    return status == noErr ? ids : nil
}

private func isTarget(_ bundleID: String?) -> Bool {
    guard let bundleID else { return false }
    return bundleID == targetBundleID || bundleID.hasPrefix(targetBundleID + ".")
}

private func meetingAudioIsActive() -> Bool? {
    guard let objects = audioProcessIDs() else { return nil }
    for objectID in objects {
        guard let pid: pid_t = readValue(objectID, selector: kAudioProcessPropertyPID, initial: 0),
              isTarget(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier) else { continue }
        let input: UInt32 = readValue(objectID, selector: kAudioProcessPropertyIsRunningInput, initial: 0) ?? 0
        let output: UInt32 = readValue(objectID, selector: kAudioProcessPropertyIsRunningOutput, initial: 0) ?? 0
        if input != 0 || output != 0 { return true }
    }
    return false
}

while true {
    autoreleasepool {
        guard let active = meetingAudioIsActive() else {
            fputs("Unable to read Core Audio process list\n", stderr)
            exit(1)
        }
        print("{\"active\":\(active ? "true" : "false")}")
        fflush(stdout)
    }
    Thread.sleep(forTimeInterval: 0.5)
}
