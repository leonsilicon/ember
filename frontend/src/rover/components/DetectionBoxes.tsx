import type { StreamedBox } from '../detections'

/**
 * The phone's leaf detector boxes over its live picture, as its camera screen draws them: the box in
 * the label's colour with its tag above (inside, near the top edge). Positions are fractions of the
 * frame, so this fills exactly the picture it sits on. Dashed: the tracker is coasting on it.
 */
export function DetectionBoxes({ boxes }: { boxes: readonly StreamedBox[] }) {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {boxes.map((box) => (
        <div
          key={box.id}
          className="absolute rounded-[3px] border-2 transition-[left,top,width,height] duration-150 ease-out"
          style={{
            left: `${box.x0 * 100}%`,
            top: `${box.y0 * 100}%`,
            width: `${(box.x1 - box.x0) * 100}%`,
            height: `${(box.y1 - box.y0) * 100}%`,
            borderColor: box.color,
            borderStyle: box.coasting ? 'dashed' : 'solid',
            opacity: box.coasting ? 0.7 : 1,
          }}
        >
          <span
            className={`absolute left-[-2px] max-w-[36ch] truncate rounded-[3px] px-1.5 text-[11px] leading-[18px] font-semibold whitespace-nowrap text-white ${
              box.y0 < 0.05 ? 'top-0.5 left-0.5' : 'bottom-full mb-0.5'
            }`}
            style={{ backgroundColor: box.color }}
            title={box.text}
          >
            {box.text}
          </span>
        </div>
      ))}
    </div>
  )
}
