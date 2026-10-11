# World Live render-test trigger

This directory exists only to dispatch the isolated one-desk Agyata World Live integration workflow.
The workflow checks out agyata-pipeline-private@feat/live-broadcast-module and deliberately does not receive YouTube credentials.

Validation retry after fixing the isolated segment producer's zoompan filter-string syntax.

Retry syntax + real segment validation after the isolated RTMPS URL parser fix.

Retry isolated render after authenticating licensed visual sources, enabling encoder stderr, and setting a 24-hour story freshness gate.
