import Foundation
import QuickLookUI
import UniformTypeIdentifiers
import ScicPreviewBridge

@objc(PreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        // Quick Look owns this extension process; the parser has no app, network,
        // or backend access. The reply is plain text, never interpreted markup.
        let fileURL = request.fileURL
        return QLPreviewReply(dataOfContentType: .plainText,
                              contentSize: CGSize(width: 800, height: 800)) { reply in
            var output: UnsafeMutablePointer<CChar>?
            var failure: UnsafeMutablePointer<CChar>?
            let status = fileURL.path.withCString {
                scic_preview_read($0, &output, &failure)
            }
            defer {
                scic_preview_free(output)
                scic_preview_free(failure)
            }
            reply.stringEncoding = .utf8
            if status == 0, let output {
                return Data(String(cString: output).utf8)
            }
            let detail = failure.map { String(cString: $0) } ?? "Unknown error"
            return Data("Preview unavailable: \(detail)".utf8)
        }
    }
}
