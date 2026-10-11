# World Live render-test trigger

This directory exists only to dispatch the isolated one-desk Agyata World Live integration workflow.
The workflow checks out agyata-pipeline-private@feat/live-broadcast-module and deliberately does not receive YouTube credentials.

Validation retry after fixing the isolated segment producer's zoompan filter-string syntax.

Retry syntax + real segment validation after the isolated RTMPS URL parser fix.

Retry isolated render after authenticating licensed visual sources, enabling encoder stderr, and setting a 24-hour story freshness gate.

Retry USA desk after adding caption-matched licensed visual recovery, independent visual-query review and bounded script compression.


Retry the isolated end-to-end country programme test after switching the Live adapter to the established build_short renderer. This remains render-only and does not receive YouTube credentials.
