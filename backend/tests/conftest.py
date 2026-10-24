from rover_vision.tasks import Role, TaskSpec

# Stand-in multi-role task for generic dataset/detection tests (the real
# trained task, hazards, only has one role).
TOY = TaskSpec(
    name="toy",
    description="test task",
    classes=(
        ("dead_leaf", Role.TARGET),
        ("pine_needle_cluster", Role.TARGET),
        ("green_plant", Role.AVOID),
        ("obstacle", Role.AVOID),
        ("leaf_pile", Role.TARGET),
    ),
)
