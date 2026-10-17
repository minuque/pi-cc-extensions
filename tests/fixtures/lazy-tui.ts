/** 精确模拟 Pi 0.84.1 createInteractiveTuiReference 的 renderer 重绑语义。 */
export function createLazyProxy<T extends object>(getRenderer: () => T): T {
	return new Proxy({} as T, {
		get: (_target, property) => {
			const tui = getRenderer();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: any[]) => {
				const currentTui = getRenderer();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`not callable: ${String(property)}`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => Reflect.set(getRenderer(), property, value, getRenderer()),
		has: (_target, property) => Reflect.has(getRenderer(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	});
}
