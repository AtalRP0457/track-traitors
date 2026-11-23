import type { Metadata } from "next";
import Link from "next/link";
import { t, type StringKey } from "@/shared/strings";

export const metadata: Metadata = { title: `${t("privacy.title")} · ${t("meta.title")}` };

const SECTIONS: { title: StringKey; items: StringKey[] }[] = [
  { title: "privacy.collectTitle", items: ["privacy.collect1", "privacy.collect2", "privacy.collect3", "privacy.collect4"] },
  { title: "privacy.notTitle", items: ["privacy.not1", "privacy.not2", "privacy.not3"] },
  { title: "privacy.adsTitle", items: ["privacy.ads"] },
  { title: "privacy.kidsTitle", items: ["privacy.kids"] },
  { title: "privacy.contactTitle", items: ["privacy.contact"] },
];

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 leading-relaxed">
      <h1 className="text-4xl font-black">{t("privacy.title")}</h1>
      <p className="opacity-60">{t("privacy.updated")}</p>
      <p className="text-lg">{t("privacy.intro")}</p>
      {SECTIONS.map((s) => (
        <section key={s.title}>
          <h2 className="mb-2 text-2xl font-bold">{t(s.title)}</h2>
          {s.items.length > 1 ? (
            <ul className="list-disc space-y-1 pl-6">
              {s.items.map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
          ) : (
            <p>{t(s.items[0])}</p>
          )}
        </section>
      ))}
      <Link href="/" className="inline-block underline">
        {t("privacy.back")}
      </Link>
    </main>
  );
}
