import pytest

from compare import prompts


@pytest.mark.parametrize("request_, summary", [
    ("tell me a story about a dog who wants to fly", "A story about a dog who wants to fly."),
    ("can you tell me a bedtime story", "A bedtime story."),
    ("a story about a brave little sparrow", "A story about a brave little sparrow."),
    ("tell me a funny story about a cat and a hat", "A funny story about a cat and a hat."),
    ("story about a girl who finds a shiny stone", "A story about a girl who finds a shiny stone."),
    ("a story with a boat and a big wave please", "A story with a boat and a big wave."),
    ("can i have a story about a princess who likes bugs", "A story about a princess who likes bugs."),
    ("make a story about a train that goes really fast", "A story about a train that goes really fast."),
    ("can you make a story about the moon", "A story about the moon."),
    ("Tell me a story about RAIN?", "A story about rain."),
])
def test_to_summary_strips_only_the_request_wrapper(request_, summary):
    assert prompts.to_summary(request_) == summary


def test_to_summary_refuses_an_empty_result():
    with pytest.raises(ValueError):
        prompts.to_summary("tell me")


def test_instruct_prompt_is_the_dataset_layout():
    # Layout pinned from TinyStories-Instruct-valid.txt: field lines, then "Story: " and a newline.
    assert prompts.INSTRUCT_TEMPLATE == "Summary: {summary}\nStory: \n"
    assert prompts.instruct_prompt("tell me a story about rain") == "Summary: A story about rain.\nStory: \n"


def test_every_request_in_the_file_adapts():
    reqs = prompts.load_requests()
    assert len(reqs) == 20
    for r in reqs:
        s = prompts.to_summary(r)
        assert s[0].isupper() and s.endswith(".") and len(s) > 8, (r, s)


def test_the_paper_prompts_are_the_pinned_44():
    ps = prompts.load_completion_prompts()
    assert len(ps) == 44
    assert all(p.strip() for p in ps)
