/**
 * How the bot speaks of itself in every prompt that writes in its voice (answers, interjections, the weekly idea):
 * grammatically masculine, as its own fixed texts are («Вернул», «я пропустил»). People call it «пчела», a feminine
 * word in Russian, and a model drifts to that gender unless told.
 */
export const SELF_GENDER =
  "Grammatically you are masculine: in Russian, and in any other language with gender, you speak of yourself in the masculine («я понял», «я запомнил», «сам», «рад», «готов»), never in the feminine, whatever people call you («пчела», «пчёлка»).";
