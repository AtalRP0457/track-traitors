import Link from "next/link";
import { t } from "@/shared/strings";

export default function Home() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 p-6 text-center">
      <h1 className="text-5xl font-black tracking-tight">
        {t("home.titleA")} <span style={{ color: "var(--traitor)" }}>{t("home.titleB")}</span>
      </h1>
      <p className="max-w-md text-lg opacity-80">
        {t("meta.tagline")}
      </p>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Link href="/host" className="rounded-2xl px-8 py-4 text-xl font-bold text-black" style={{ background: "var(--racer)" }}>
          {t("home.host")}
        </Link>
        <Link href="/play" className="rounded-2xl border-2 px-8 py-4 text-xl font-bold" style={{ borderColor: "var(--racer)" }}>
          {t("home.join")}
        </Link>
      </div>
      <Link href="/privacy" className="text-sm underline opacity-60">
        {t("privacy.link")}
      </Link>
    </main>
  );
}
