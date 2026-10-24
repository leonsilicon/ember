import type { FrameCapture } from '../hooks/useFrameCapture'

const btn = 'rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-40'

/** Folder, record and snap buttons for a camera panel, and where the frames go. */
export function CaptureControls({ capture, ready }: { capture: FrameCapture; ready: boolean }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        {capture.supportsFolder && (
          <button
            type="button"
            onClick={() => void capture.chooseFolder()}
            disabled={capture.recording}
            className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}
          >
            {capture.dirName ? `Folder: ${capture.dirName}` : 'Choose folder…'}
          </button>
        )}
        {capture.recording ? (
          <button type="button" onClick={capture.stop} className={`${btn} bg-red-600 text-white hover:bg-red-500`}>
            Stop (1 fps)
          </button>
        ) : (
          <button type="button" onClick={capture.start} disabled={!ready} className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}>
            Record 1 fps
          </button>
        )}
        <button
          type="button"
          onClick={() => void capture.snap()}
          disabled={!ready}
          className={`${btn} bg-zinc-800 text-zinc-100 hover:bg-zinc-700`}
        >
          Snap one
        </button>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Frames are saved as <span className="font-mono">frame_0001.jpg…</span>
        {capture.supportsFolder ? ' into the chosen folder' : ' via downloads (choose a folder needs Chrome)'}. Walk slowly
        around the object with lots of overlap; 30–80 frames is a good first run.
      </p>
      {capture.error && <p className="mt-2 text-xs text-red-300">{capture.error}</p>}
    </>
  )
}
