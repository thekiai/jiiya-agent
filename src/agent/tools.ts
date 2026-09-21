import type { ToolDef } from "../llm/client.js";

/** LLM に見せるツール定義。実行は loop.ts の runTool。 */
export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_free_slots",
      description: "本人のカレンダーとルールから、空いている候補を取る。日程・打ち合わせの話のときに最初に呼ぶ。",
      parameters: {
        type: "object",
        properties: {
          range_days: { type: "integer", description: "今日から何日先まで探すか（例: 7）。「来週」なら 10。", minimum: 1, maximum: 30 },
          duration_min: { type: "integer", description: "所要時間（分）。相手が言っていなければ省略。", minimum: 5 },
          earliest_days_from_now: { type: "integer", description: "何日後から探すか（「来週」なら次の月曜までの日数）。省略時 0。", minimum: 0 },
        },
        required: ["range_days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_slots",
      description: "get_free_slots で得た候補を相手に提示する。候補が0件なら呼ばず、ask_owner で本人に聞く。",
      parameters: {
        type: "object",
        properties: {
          slot_ids: { type: "array", items: { type: "integer" }, description: "提示する候補の id（get_free_slots の結果から）" },
          message: {
            type: "string",
            description:
              "相手への文。候補の日時は {slots} と書けば差し込まれる。空き状況だけを述べる（「予定を動かした」「本人が調整した」など、していないことは書かない）。例: 来週だと {slots} が空いてます！どっちがいいですか？",
          },
        },
        required: ["slot_ids", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_slot",
      description: "相手が提示済みの候補から1つ選んだら、その候補で本人のカレンダーに予定を入れる。",
      parameters: {
        type: "object",
        properties: {
          slot_id: { type: "integer", description: "選ばれた候補の id" },
          title: { type: "string", description: "予定のタイトル（例: 高橋さんとLPの件）" },
          message: {
            type: "string",
            description:
              "相手への確定連絡。予定を入れて相手を招待したことを伝える。例: 木曜14時で予定を入れて、招待をお送りしました！",
          },
        },
        required: ["slot_id", "title", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_slot",
      description:
        "相手が具体的な日時を出してきたとき（相手のじいやの候補提示など）、その時間に本人が空いているかをカレンダーとルールで確認する。空いていれば候補 id が返るので、そのまま book_slot で予定を入れられる。",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "開始日時。ISO 8601（例 2026-09-22T10:00:00+09:00）" },
          duration_min: { type: "number", description: "所要分。省略時は既定" },
        },
        required: ["start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_owner",
      description: "本人の意思がないと答えられないとき、本人へ短い質問をする。選択肢に絞ると本人が楽。この後スレッドには何も返さない。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "本人への質問。1文。キャラの口調で（本人は主人）。相手のメッセージは本人にも見えているので繰り返さず、何を決めてほしいかだけ聞く。",
          },
          options: {
            type: "array",
            description:
              "選択肢（2〜4個）。label は本人に見せる文、action は押したときに起きること（この4種類だけ。他は無い）:\n- relay: label を本人の答えとして相手に伝聞で伝える（例「今回は見送ると伝える」「税別と伝える」）\n- reschedule: 本人のカレンダーの空きから候補を出し直す\n- shorten: 短時間（15分）にして候補を出す\n- book: 提示済みの候補で予定を入れる（slot_id 必須）\n既存の予定を動かす・作業をする等、この4種類でできないことは選択肢にしない。答えが自由文になるなら空にする。",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["relay", "reschedule", "shorten", "book"] },
                label: { type: "string", description: "本人に見せる短い文。それを選ぶだけで答えになる内容" },
                slot_id: { type: "number", description: "action=book のとき、提示済み候補の id" },
              },
              required: ["action", "label"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_approval",
      description: "金額・納期の約束・依頼の断りなど、文面そのものを本人に見てもらう必要があるときに、相手への返信案を本人に承認してもらう。",
      parameters: {
        type: "object",
        properties: { draft: { type: "string", description: "相手に送る返信案の全文（伝聞、ラベルなし）。" } },
        required: ["draft"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hand_off",
      description: "クレーム・謝罪・感情的なやり取り・契約など、じいやが間に入るべきでないとき。スレッドには何も書かず本人に知らせる。",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "本人に伝える理由。1文。" } },
        required: ["reason"],
      },
    },
  },
];
