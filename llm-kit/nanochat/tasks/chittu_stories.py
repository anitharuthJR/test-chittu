"""
Chittu story pairs for SFT — the story lane's replacement for SmolTalk/MMLU/GSM8K.

Reads $NANOCHAT_DATA_DIR/stories.sft.<split>.jsonl, written by chittu/build_dataset.py:
one {"messages": [user, assistant]} per line, the user turn a story request and the
assistant turn the story. Nothing is downloaded.
"""
import json

from chittu.common import data_dir
from tasks.common import Task


class ChittuStories(Task):
    def __init__(self, split, **kwargs):
        super().__init__(**kwargs)
        assert split in ["train", "val"], "ChittuStories split must be train|val"
        path = data_dir() / f"stories.sft.{split}.jsonl"
        with open(path, encoding="utf-8") as f:
            self.rows = [json.loads(line) for line in f if line.strip()]
        self.length = len(self.rows)

    def num_examples(self):
        return self.length

    def get_example(self, index):
        messages = self.rows[index]["messages"]
        assert len(messages) == 2, f"story pair {index} must have exactly a user and an assistant turn"
        assert messages[0]["role"] == "user" and messages[1]["role"] == "assistant", f"story pair {index} roles must be user, assistant"
        assert isinstance(messages[0]["content"], str) and isinstance(messages[1]["content"], str), "content must be a string"
        return {"messages": messages}
