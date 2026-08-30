# Wheels Stage V1 authority

Migration `0023_wheels_stages_v1.sql` adds normalized `wheel_stages` and `wheel_stage_items` tables. A Stage references one to six existing Wheels by position; Wheel entries, configuration, media, official spins, and lifecycle remain owned by existing Wheel tables.

Public reads expose only active public Stages whose members are active public Wheels. Signed internal reads reauthorize the Stage owner or Master Admin and independently resolve each Wheel. Mutations require the canonical Public session, CSRF validation at Public, a time-bounded service signature at Admin, creator grant, owner or Master Admin access, revision matching, rate limits, and audit events.

Admin `/wheels/stages` is a distinct management surface with hide, archive, restore, and delete actions. Stage deletion cascades only Stage membership; Wheels and official results are preserved.
