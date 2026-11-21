import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFooter } from "./footer.ts";
import { registerNotify } from "./notify.ts";

export default function piBar(pi: ExtensionAPI): void {
  registerNotify(pi);
  registerFooter(pi);
}
