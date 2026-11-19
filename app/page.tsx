import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 p-6 text-center">
      <h1 className="text-5xl font-black tracking-tight">
        Track <span style={{ color: "var(--traitor)" }}>Traitors</span>
      </h1>
      <p className="max-w-md text-lg opacity-80">
        Race your friends. Hide traps on their track. Find the traitor before the finish line.
      </p>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Link href="/host" className="rounded-2xl px-8 py-4 text-xl font-bold text-black" style={{ background: "var(--racer)" }}>
          Host on this screen
        </Link>
        <Link href="/play" className="rounded-2xl border-2 px-8 py-4 text-xl font-bold" style={{ borderColor: "var(--racer)" }}>
          Join with my phone
        </Link>
      </div>
    </main>
  );
}
