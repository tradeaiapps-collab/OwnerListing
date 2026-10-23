# Scaling to a million users, and the human team

Writing code well is part of it. Reaching a million users is mostly architecture, operations and testing.

## Scaling plan
| Area | Approach |
|---|---|
| App servers | Stateless, behind a load balancer, scale out. The business rules are already pure functions with no hidden state. |
| Database | Managed PostgreSQL with a connection pooler and read replicas. Indexes on every list query. Time-ordered IDs (UUIDv7) for the biggest tables. |
| Big tables | Partition by month: audit_event, chat_message, property_event, ai_learning_event. Archive old partitions, never delete. |
| Lists and search | Keyset pagination (src/domain/pagination.ts), never OFFSET. Add a search engine when listing search outgrows PostgreSQL. |
| Photos, video, 360 | Object storage with a CDN. Large videos upload directly to storage in resumable parts, then are converted in the background. |
| Slow work | Background job queues for AI calls, email, SMS, translation and video conversion. Webhooks are idempotent. |
| Protection | Rate limits per user and per address, bot protection on sign-up, request size limits. |
| Caching | CDN for public listing pages and images. Never cache private data. |
| Hosting location | Australian region, because personal data leaving Australia has Privacy Act duties. |
| Proof | Load-test to the playbook's targets before launch, and again before each growth step. Monitoring, alerts, backups and a tested restore. |

## Human team (to be hired or contracted)
| Role | At launch | At scale | Job |
|---|---|---|---|
| Engineering lead | 1 | 1 | Architecture, code review, releases |
| Full-stack engineers | 3 | 6+ | Build features, fix bugs, recode when needed |
| DevOps / reliability engineer | 1 | 2 | Hosting, deployments, monitoring, on-call, backups |
| Security engineer | 1 (part-time or contract) | 1 | Penetration tests, access reviews, SOC 2 preparation |
| QA engineer | 1 | 2 | Test plans, release checks |
| Data and AI engineer | 1 | 2 | AI evaluation, learning data pipeline, model choice |
| Compliance officer | 1 | 1 | Licensing, disclosures, verification cases; works with external counsel |
| Support lead and staff | 1 | grows with users | Support cases, trust-account verification takeovers |
| Product owner and designer | 1 | 2 | Roadmap, screens, accessibility |
| Accountant | part-time | 1 | Billing reports, GST, reconciliation |

Regular maintenance: monthly dependency and security updates (like the audit fix on 22 Oct), quarterly restore tests, yearly penetration test, an on-call roster once there are live users.
