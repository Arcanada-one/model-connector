# MiniMax/Hailuo international video connector

This connector covers only the first-party international MiniMax API at
`https://api.minimax.io/v1`. It does not cover the separate PRC platform.

## Supported workflow

All video creation modes use `POST /video_generation` with bearer authentication. The
request type exposes the four modes documented by MiniMax:

- text-to-video;
- image-to-video (`first_frame_image`);
- first-and-last-frame video (`first_frame_image` plus `last_frame_image`);
- subject-reference video (`subject_reference`).

Creation returns a `task_id`. `GET /query/video_generation?task_id=...` returns one of
`Preparing`, `Queueing`, `Processing`, `Success`, or `Fail`. A successful task can return a
`file_id`; `GET /files/retrieve?file_id=...` returns the file metadata and download URL.

The connector accepts an injected transport and API key. It does not create an HTTP client,
read environment variables, perform polling, download the returned URL, or make live calls.
MiniMax does not document callbacks, task-list pagination, customer-selectable regions, or a
general retention/retirement SLA for this workflow, so the connector makes no such claims.

## First-party sources

- [Video generation guide](https://platform.minimax.io/docs/guides/video-generation)
- [Text-to-video](https://platform.minimax.io/docs/api-reference/video-generation-t2v)
- [Image-to-video](https://platform.minimax.io/docs/api-reference/video-generation-i2v)
- [First/last-frame video](https://platform.minimax.io/docs/api-reference/video-generation-fl2v)
- [Subject-reference video](https://platform.minimax.io/docs/api-reference/video-generation-s2v)
- [Query task](https://platform.minimax.io/docs/api-reference/video-generation-query)
- [Retrieve generated file](https://platform.minimax.io/docs/api-reference/video-generation-download)
- [API overview and current model catalogue](https://platform.minimax.io/docs/api-reference/api-overview)
