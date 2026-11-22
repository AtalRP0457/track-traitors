import { notFound } from "next/navigation";
import DevApp from "@/controller/DevApp";

export const metadata = { title: "Dev · Track Traitors" };

/** Dev tools: fake phones + network simulator. Not available in production builds. */
export default function DevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DevApp />;
}
