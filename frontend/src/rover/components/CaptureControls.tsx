import type { FrameCapture } from '../hooks/useFrameCapture'
import { Button, Hint, Icons } from '../ui/kit'

/** Folder, record and snap buttons for a camera panel, and where the frames go. */
export function CaptureControls({ capture, ready }: { capture: FrameCapture; ready: boolean }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {capture.recording ? (
          <Button size="sm" variant="danger" onClick={capture.stop}>
            <Icons.square />
            Stop recording
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={capture.start} disabled={!ready}>
            <Icons.record />
            Record 1 fps
          </Button>
        )}
        <Button size="sm" onClick={() => void capture.snap()} disabled={!ready}>
          <Icons.camera />
          Snap one
        </Button>
        {capture.supportsFolder && (
          <Button size="sm" variant="ghost" onClick={() => void capture.chooseFolder()} disabled={capture.recording} className="max-w-full">
            <Icons.folder />
            <span className="truncate">{capture.dirName ? capture.dirName : 'Choose folder…'}</span>
          </Button>
        )}
      </div>

      <Hint className="mt-3">
        Frames are saved as <span className="num">frame_0001.jpg…</span>
        {capture.supportsFolder ? ' into the chosen folder' : ' via downloads (choosing a folder needs Chrome)'}. Walk slowly round the
        object with lots of overlap; 30–80 frames is a good first run.
      </Hint>
      {capture.error && <p className="mt-2 text-xs text-danger">{capture.error}</p>}
    </>
  )
}
