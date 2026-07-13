<!-- orch-decompose task-graph · schema_version: 1 -->

# Staleness fixture — task graph

| id | title | stage | model | status | depends_on | node_file | base_commit |
|----|-------|-------|-------|--------|------------|-----------|-------------|
| n1 | stale against merged upstream | work | generation | not-started | n3 | n1.md | aaaa111 |
| n2 | fresh — merge already in base | work | generation | not-started | n3 | n2.md | bbbb222 |
| n3 | root work node | work | ceiling | done |  | n3.md | cccc333 |
| n4 | still a plan node | plan | generation | not-started | n3 | n4.md |  |
| n5 | work node with no base_commit | work | generation | not-started | n3 | n5.md |  |
