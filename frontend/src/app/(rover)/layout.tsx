import './rover.css';

export const metadata = { icons: '/favicon.svg' };

/**
 * The laptop pages' root layout (rover control, the autopilot simulator, the wildfire map): dark,
 * full-height and styled with Tailwind. It's a root layout of its own, beside the splat pages'
 * (`../(splat)/layout.tsx`), so Tailwind's base styles never reach those pages.
 */
export default function RoverLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
