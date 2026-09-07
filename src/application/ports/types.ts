/** Every subscription in this codebase hands back the same thing: how to stop. */
export type Unsubscribe = () => void;

export type Listener<T> = (value: T) => void;
