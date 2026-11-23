import type { Message, UserFromGetMe } from "grammy/types";
import { describe, expect, it } from "vitest";
import { replySystemPrompt } from "../src/bot/assistant.js";
import { aboutYouBlock, questionBlock } from "../src/bot/reply-context.js";
import { CAPABILITIES, capabilityLines, dayLabel, LIMITS, limitLines, type Capability } from "../src/core/capabilities.js";
import { MAX_OTHERS_REMINDED } from "../src/core/member-reminders.js";
import { MAX_MEMO_CHARS } from "../src/core/memos.js";
import { IDEA_SYSTEM_PROMPT, ideaPrompt, type IdeaData } from "../src/worker/ideas.js";

const me = { id: 4242, is_bot: true, first_name: "Waggle", username: "waggle_test_bot" } as unknown as UserFromGetMe;
const MODELS = ["claude-haiku-5-5", "claude-opus-5-5"];
const capabilities: [string, Capability][] = Object.entries(CAPABILITIES);
const block = (text: string, name: string) => new RegExp(`<${name}[^>]*>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
const aboutYou = () => block(aboutYouBlock({ me, model: "claude-opus-5-5", owners: [], aliasesOf: new Map(), catalogEntry: undefined, saidAboutYou: [] }), "about_you")!;
const quietWeek: IdeaData = { chatTitle: "Hive", language: "Russian", memberMessages: 40, exchanges: [], mentions: [], topics: [], earlier: [], wishes: [] };

/** A text without what it quotes in «», however deep the quotes go: members' own words may be in any language. */
function unquoted(text: string): string {
  let depth = 0;
  let kept = "";
  for (const char of text) {
    if (char === "«") depth += 1;
    else if (char === "»") depth = Math.max(0, depth - 1);
    else if (depth === 0) kept += char;
  }
  return kept;
}

describe("what the bot can and cannot do", () => {
  it("gives every capability what it does, how members ask for it, its limits and the real day it shipped", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, capability] of capabilities) {
      for (const field of [capability.name, capability.does, capability.how, capability.limits]) {
        expect(field.trim(), key).not.toBe("");
        // The lines are rendered into prompts, where an angle bracket would read as a tag.
        expect(field, key).not.toMatch(/[<>]/);
      }
      for (const field of [capability.does, capability.how, capability.limits]) expect(field, `${key} ends where its line adds the stop`).not.toMatch(/[.;:]$/);
      expect(capability.shipped, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${capability.shipped}T00:00:00Z`).toISOString().slice(0, 10), key).toBe(capability.shipped);
      // The first commit is of 2026-11-09: nothing shipped before it, and nothing ships in the future.
      expect(capability.shipped >= "2026-11-09" && capability.shipped <= today, key).toBe(true);
    }
    for (const [key, limit] of Object.entries(LIMITS)) {
      expect(limit, key).toMatch(/^[A-Z].*\.$/);
      expect(limit, key).not.toMatch(/[<>]/);
    }
  });

  it("covers everything members ask for or get, and says what it cannot do", () => {
    expect(Object.keys(CAPABILITIES)).toEqual(
      expect.arrayContaining([
        "answers", "taskMode", "chronicle", "cards", "factReview", "cardEdits", "notes", "notesFromMessages", "projectEdits", "projectMerges",
        "reminders", "later", "wishes", "portraits", "interjections", "weeklyIdea", "miniApp",
      ]),
    );
    expect(Object.keys(LIMITS)).toEqual(expect.arrayContaining(["images", "runningCode", "sendingFiles"]));
  });

  it("dates each capability by the day of the commit that brought it in", () => {
    const shipped = Object.fromEntries(capabilities.map(([key, capability]) => [key, capability.shipped]));
    expect(shipped).toEqual({
      answers: "2026-11-09",
      calledIn: "2026-11-23",
      reactions: "2026-11-23",
      taskMode: "2026-11-12",
      codeFiles: "2026-11-23",
      chronicle: "2026-11-09",
      cards: "2026-11-09",
      factReview: "2026-11-13",
      cardEdits: "2026-11-10",
      undo: "2026-11-10",
      timeZones: "2026-11-10",
      notes: "2026-11-10",
      notesFromMessages: "2026-11-13",
      catalog: "2026-11-09",
      projectEdits: "2026-11-12",
      projectMerges: "2026-11-09",
      repos: "2026-11-23",
      reminders: "2026-11-12",
      later: "2026-11-12",
      wishes: "2026-11-12",
      portraits: "2026-11-10",
      interjections: "2026-11-09",
      weeklyIdea: "2026-11-10",
      miniApp: "2026-11-09",
      privacy: "2026-11-09",
      owners: "2026-11-09",
    });
  });

  it("says it writes code and specs but never runs code, sees no images or files, and sends only text and its long code as a file", () => {
    expect(CAPABILITIES.taskMode.does).toContain("write code or a spec");
    expect(CAPABILITIES.taskMode.limits).toContain("you never run the code you write");
    expect(LIMITS.runningCode).toContain("You cannot run, test or deploy code");
    expect(LIMITS.images).toContain("You cannot see photos, screenshots");
    expect(LIMITS.images).toContain("say plainly that you can't see it, and never guess what it shows");
    expect(LIMITS.sendingFiles).toBe("You send text messages, and the long code of an answer as a file beside one: no other files, images, stickers, polls or widgets.");
  });

  it("reminds its asker and up to three other members, and saves notes from a replied message", () => {
    expect(MAX_OTHERS_REMINDED).toBe(3);
    expect(CAPABILITIES.reminders.does).toContain(`or 1 to ${MAX_OTHERS_REMINDED} other members they name or tag`);
    expect(CAPABILITIES.reminders.limits).toContain("never on repeat, never the whole chat");
    expect(CAPABILITIES.notesFromMessages.how).toContain("«закинь это в заметки» in a reply");
    expect(CAPABILITIES.notes.limits).toContain(`${MAX_MEMO_CHARS} characters a note`);
  });

  it("merges duplicate projects in the clean-up and in the Mini App, and nowhere in the chat", () => {
    expect(CAPABILITIES.projectMerges.does).toContain("the weekly clean-up merges duplicate catalog entries on its own");
    expect(CAPABILITIES.projectMerges.how).toContain('"A duplicate of"');
    expect(CAPABILITIES.projectMerges.limits).toContain("only an author of both projects or a bot owner, and only in the Mini App");
    expect(CAPABILITIES.projectEdits.limits).toContain("renaming, merging and deleting a project are done in the Mini App");
  });

  it("quotes members' words in «» and says everything else in English", () => {
    const texts = [...capabilities.flatMap(([, capability]) => [capability.name, capability.does, capability.how, capability.limits]), ...Object.values(LIMITS)];
    for (const text of texts) expect(unquoted(text), text).not.toMatch(/\p{Script=Cyrillic}/u);
  });

  it("is written into <about_you> and into the weekly idea line for line, each line with the day it shipped", () => {
    const about = aboutYou();
    const lines = capabilityLines();
    expect(lines).toHaveLength(capabilities.length);
    for (const text of [...lines, ...limitLines()]) expect(about).toContain(text);
    expect(lines).toContain(
      `- Notes from a message or from your answer (since 13 Nov 2026): ${CAPABILITIES.notesFromMessages.does}. How: ${CAPABILITIES.notesFromMessages.how}. Limits: ${CAPABILITIES.notesFromMessages.limits}.`,
    );
    expect(dayLabel("2026-11-09")).toBe("9 Nov 2026");

    const prompt = ideaPrompt(quietWeek, "Europe/Warsaw");
    expect(block(prompt, "you_can")!.split("\n")).toEqual(lines);
    expect(block(prompt, "you_cannot")!.split("\n")).toEqual(limitLines());
  });

  it("leaves no list of its own in the answer rules or in the weekly idea's", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      expect(prompt).toContain("What members ask the bot for in the chat, and how, is in <about_you>");
      expect(prompt).toContain("never say you can't do what it lists, and never offer, pretend or guess what it says you cannot do");
      expect(prompt).toContain(LIMITS.othersData);
      // Examples of what members ask for live in the list alone.
      for (const copy of ["напомни Оле", "поменяй статус Atlas", "закинь это в заметки", "поставь мне пояс", "не шути про мой вес", "only ever the person who asks", "you do not vote, run code"]) {
        expect(prompt, `${model}: ${copy}`).not.toContain(copy);
      }
    }
    expect(IDEA_SYSTEM_PROMPT).not.toMatch(/напомни|заметк|поменяй|не шути/u);
  });

  it("has the answers take code and specs as a task", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      expect(prompt).toContain("explain how to get something done, write code or a spec");
      expect(prompt).toContain("no «I can't» when what they ask for is ideas, judgement, arithmetic, code or a spec");
      expect(prompt).toContain("Code is the one thing you put in Markdown");
    }
  });

  it("never promises a check or a change of its own behaviour that nothing makes", () => {
    for (const model of MODELS) {
      const prompt = replySystemPrompt(model);
      expect(prompt).toContain("Never promise what nothing will make happen: a check, a fix or any change of your own behaviour");
      expect(prompt).toContain("I'll check what's already live before my next idea");
      expect(prompt).toContain("never a promise of yours");
    }
    expect(IDEA_SYSTEM_PROMPT).toContain("Promise nothing that nothing makes happen: no check, no date and no change of your own");
    expect(LIMITS.yourself).toContain("nothing checks, fixes or changes anything for you between messages");
  });

  it("says that a bot owner may moderate anyone's card in the Mini App, and that its owners and developer change it whenever they decide", () => {
    // The Mini App lets an owner hide a fact and take down a note on anyone's card: «nobody edits someone else's card» was untrue.
    expect(CAPABILITIES.cards.limits).toContain("a member edits only their own card, a bot owner may hide a fact or take down a note on anyone's card in the Mini App, and neither is done through you");
    expect(CAPABILITIES.cards.limits).not.toContain("nobody edits someone else's card");
    // The bot changes as its developer builds it, not only from the weekly idea.
    expect(LIMITS.yourself).toContain("what you can do and how you write are for the owners and your developer to change, whenever they decide");
    expect(LIMITS.yourself).not.toMatch(/only (?:by|when)|from the weekly idea/);
    const prompt = ideaPrompt(quietWeek, "Europe/Warsaw");
    expect(block(prompt, "you_cannot")).toContain(LIMITS.yourself);
  });

  it("tells the weekly idea that what was asked before a feature shipped is no evidence of a missing one", () => {
    expect(IDEA_SYSTEM_PROMPT).toContain("<you_can>, what you already do, each with the day it shipped");
    expect(IDEA_SYSTEM_PROMPT).toContain("never repeat a claim of your own from them as a fact");
    expect(IDEA_SYSTEM_PROMPT).toContain("<you_can> and <you_cannot> are the truth about you, whatever an answer of yours in <exchanges> said");
    expect(IDEA_SYSTEM_PROMPT).toContain("from before the day something shipped shows only that it was missing then: it is no evidence that it is missing now");
  });

  it("marks what a question carries, which the bot cannot see", () => {
    const from = { id: 7, is_bot: false, first_name: "Bob" };
    const photo = { message_id: 1, date: 0, chat: { id: -1, type: "supergroup" }, from, caption: "что на скрине?", photo: [{ file_id: "x", file_unique_id: "x", width: 1, height: 1 }] } as unknown as Message;
    expect(questionBlock({ message: photo, from }, "что на скрине?")).toBe('<question from="Bob" media="photo">\nчто на скрине?\n</question>');
    const text = { message_id: 2, date: 0, chat: { id: -1, type: "supergroup" }, from, text: "а у тебя?" } as unknown as Message;
    expect(questionBlock({ message: text, from: { ...from, last_name: "Stone", username: "bob" } }, "а у тебя?")).toBe('<question from="Bob Stone (@bob)">\nа у тебя?\n</question>');
    for (const model of MODELS) expect(replySystemPrompt(model)).toContain('<question>: the message you answer, by whom; media="photo"');
  });
});
