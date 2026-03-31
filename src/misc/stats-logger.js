/**
 * Periodic stats logger for point cloud rendering.
 * Logs FPS, visible points, and LOD node distribution.
 *
 * @param {object} Potree - Potree instance
 * @param {object} scene - Scene instance
 * @param {number} [interval=2000] - Log interval in milliseconds
 * @returns {number} setInterval ID (can be used with clearInterval to stop)
 */
export function startStatsLogger(Potree, scene, interval = 2000) {
	if (!Potree || !scene) {
		throw new Error("Potree and scene are required");
	}

	return setInterval(() => {
		let fps = Potree.state.fps ?? 0;
		let totalPoints = Potree.state.numVisiblePoints ?? 0;

		let lodCounts = {};
		let octrees = scene.root.children.filter(c => c.constructor.name === "PointCloudOctree");
		for (let octree of octrees) {
			for (let node of octree.visibleNodes) {
				let level = node.level ?? 0;
				lodCounts[level] = (lodCounts[level] ?? 0) + 1;
			}
		}

		let lodStr = Object.keys(lodCounts)
			.sort((a, b) => Number(a) - Number(b))
			.map(level => `L${level}:${lodCounts[level]}`)
			.join(" ");

		console.log(`\nFPS: ${fps}    Points: ${totalPoints.toLocaleString()}\n\nLOD nodes: ${lodStr}\n\n`);
	}, interval);
}
