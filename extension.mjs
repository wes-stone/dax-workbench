import { joinSession } from "@github/copilot-sdk/extension";
import { createExtension } from "./src/extension/registration.mjs";

const extension = createExtension(import.meta.url);
const session = await joinSession(extension.declaration);
extension.attach(session);
