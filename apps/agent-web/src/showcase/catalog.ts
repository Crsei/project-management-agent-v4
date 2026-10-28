import { pages as conversations } from "./conversations";
import { pages as business } from "./business";
import { pages as platform } from "./platform";
import type { ShowcasePage } from "./types";

export const pages: ShowcasePage[] = [...conversations, ...business, ...platform];
