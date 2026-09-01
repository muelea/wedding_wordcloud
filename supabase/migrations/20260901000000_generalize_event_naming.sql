alter table events rename column couple_name to title;
alter table events rename column event_label to subtitle;
alter table orders rename column event_label_snapshot to event_title_snapshot;

insert into app_schema_versions (version) values (2);
