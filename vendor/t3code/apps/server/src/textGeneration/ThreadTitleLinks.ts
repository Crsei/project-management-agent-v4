import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/** Inactive pure helper. PM title generation does not install a link resolver. */
export type ThreadTitleLinkResolver = (input: { cwd: string; url: URL }) =>
  Effect.Effect<{ readonly title: string; readonly body?: string | null }, unknown> | undefined;

const encodeSubject = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);

export const resolveThreadTitleLinks = Effect.fn("resolveThreadTitleLinks")(function* (input: {
  message: string;
  cwd: string;
}, resolveLink: ThreadTitleLinkResolver) {
  const links = new Map<string, NonNullable<ReturnType<ThreadTitleLinkResolver>>>();
  for (const match of input.message.matchAll(/https:\/\/[^\s<>"')\]`]+/g)) {
    const candidate = match[0].replace(/[.,;!?]+$/, "");
    if (!URL.canParse(candidate)) continue;
    const url = new URL(candidate);
    url.hash = "";
    url.search = "";
    if (links.has(url.href)) continue;
    const lookup = resolveLink({ cwd: input.cwd, url });
    if (!lookup) continue;
    links.set(url.href, lookup);
    if (links.size === 2) break;
  }
  const subjects = yield* Effect.forEach(
    links,
    ([url, lookup]) =>
      lookup.pipe(
        Effect.flatMap((subject) =>
          encodeSubject({
            title: subject.title.slice(0, 300),
            body: subject.body?.slice(0, 1_200) ?? "",
          }),
        ),
        Effect.map((summary) => `${url}\n${summary}`),
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => `${url}: unavailable`),
      ),
    { concurrency: 2 },
  );
  return subjects.length > 0 ? subjects.join("\n\n") : undefined;
});
